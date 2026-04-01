import express, { Request, Response } from 'express';
import { db } from '../db/database';
import { authenticate } from '../middleware/auth';
import { requireTripAccess } from '../middleware/tripAccess';
import { broadcast } from '../websocket';
import { loadTagsByPlaceIds, loadParticipantsByAssignmentIds, formatAssignmentWithPlace } from '../services/queryHelpers';
import { AuthRequest, AssignmentRow, DayAssignment, Tag, Participant } from '../types';

const router = express.Router({ mergeParams: true });

function getAssignmentWithPlace(assignmentId: number | bigint) {
  const a = db.prepare(`
    SELECT da.*, da.budget_item_id, p.id as place_id, p.name as place_name, p.description as place_description,
      p.lat, p.lng, p.address, p.category_id, p.price, p.currency as place_currency,
      COALESCE(da.assignment_time, p.place_time) as place_time,
      COALESCE(da.assignment_end_time, p.end_time) as end_time,
      COALESCE(da.duration_minutes, p.duration_minutes) as duration_minutes, p.notes as place_notes,
      p.image_url, p.transport_mode, p.google_place_id, p.website, p.phone,
      c.name as category_name, c.color as category_color, c.icon as category_icon
    FROM day_assignments da
    JOIN places p ON da.place_id = p.id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE da.id = ?
  `).get(assignmentId) as AssignmentRow | undefined;

  if (!a) return null;

  const tags = db.prepare(`
    SELECT t.* FROM tags t
    JOIN place_tags pt ON t.id = pt.tag_id
    WHERE pt.place_id = ?
  `).all(a.place_id);

  const participants = db.prepare(`
    SELECT ap.user_id, u.username, u.avatar
    FROM assignment_participants ap
    JOIN users u ON ap.user_id = u.id
    WHERE ap.assignment_id = ?
  `).all(a.id);

  return {
    id: a.id,
    day_id: a.day_id,
    order_index: a.order_index,
    notes: a.notes,
    participants,
    created_at: a.created_at,
    place: {
      id: a.place_id,
      name: a.place_name,
      description: a.place_description,
      lat: a.lat,
      lng: a.lng,
      address: a.address,
      category_id: a.category_id,
      price: a.price,
      currency: a.place_currency,
      place_time: a.place_time,
      end_time: a.end_time,
      duration_minutes: a.duration_minutes,
      notes: a.place_notes,
      image_url: a.image_url,
      transport_mode: a.transport_mode,
      google_place_id: a.google_place_id,
      website: a.website,
      phone: a.phone,
      category: a.category_id ? {
        id: a.category_id,
        name: a.category_name,
        color: a.category_color,
        icon: a.category_icon,
      } : null,
      tags,
    }
  };
}

router.get('/trips/:tripId/days/:dayId/assignments', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId, dayId } = req.params;

  const day = db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(dayId, tripId);
  if (!day) return res.status(404).json({ error: 'Day not found' });

  const assignments = db.prepare(`
    SELECT da.*, p.id as place_id, p.name as place_name, p.description as place_description,
      p.lat, p.lng, p.address, p.category_id, p.price, p.currency as place_currency,
      COALESCE(da.assignment_time, p.place_time) as place_time,
      COALESCE(da.assignment_end_time, p.end_time) as end_time,
      COALESCE(da.duration_minutes, p.duration_minutes) as duration_minutes, p.notes as place_notes,
      p.image_url, p.transport_mode, p.google_place_id, p.website, p.phone,
      c.name as category_name, c.color as category_color, c.icon as category_icon
    FROM day_assignments da
    JOIN places p ON da.place_id = p.id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE da.day_id = ?
    ORDER BY da.order_index ASC, da.created_at ASC
  `).all(dayId) as AssignmentRow[];

  const placeIds = [...new Set(assignments.map(a => a.place_id))];
  const tagsByPlaceId = loadTagsByPlaceIds(placeIds, { compact: true });

  const assignmentIds = assignments.map(a => a.id);
  const participantsByAssignment = loadParticipantsByAssignmentIds(assignmentIds);

  const result = assignments.map(a => {
    return formatAssignmentWithPlace(a, tagsByPlaceId[a.place_id] || [], participantsByAssignment[a.id] || []);
  });

  res.json({ assignments: result });
});

router.post('/trips/:tripId/days/:dayId/assignments', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId, dayId } = req.params;
  const { place_id, notes } = req.body;

  const day = db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(dayId, tripId);
  if (!day) return res.status(404).json({ error: 'Day not found' });

  const place = db.prepare('SELECT id FROM places WHERE id = ? AND trip_id = ?').get(place_id, tripId);
  if (!place) return res.status(404).json({ error: 'Place not found' });

  const maxOrder = db.prepare('SELECT MAX(order_index) as max FROM day_assignments WHERE day_id = ?').get(dayId) as { max: number | null };
  const orderIndex = (maxOrder.max !== null ? maxOrder.max : -1) + 1;

  const result = db.prepare(
    'INSERT INTO day_assignments (day_id, place_id, order_index, notes) VALUES (?, ?, ?, ?)'
  ).run(dayId, place_id, orderIndex, notes || null);

  const assignment = getAssignmentWithPlace(result.lastInsertRowid);
  res.status(201).json({ assignment });
  broadcast(tripId, 'assignment:created', { assignment }, req.headers['x-socket-id'] as string);
});

router.delete('/trips/:tripId/days/:dayId/assignments/:id', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId, dayId, id } = req.params;

  const assignment = db.prepare(
    'SELECT da.id FROM day_assignments da JOIN days d ON da.day_id = d.id WHERE da.id = ? AND da.day_id = ? AND d.trip_id = ?'
  ).get(id, dayId, tripId);

  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  // Before the actual delete, check for budget_item_id
  const assignmentToDelete = db.prepare('SELECT budget_item_id FROM day_assignments WHERE id = ?').get(id) as Record<string, any> | undefined;
  if (assignmentToDelete?.budget_item_id) {
    db.prepare('DELETE FROM budget_items WHERE id = ?').run(assignmentToDelete.budget_item_id);
  }

  db.prepare('DELETE FROM day_assignments WHERE id = ?').run(id);
  res.json({ success: true });
  broadcast(tripId, 'assignment:deleted', { assignmentId: Number(id), dayId: Number(dayId) }, req.headers['x-socket-id'] as string);
});

router.put('/trips/:tripId/days/:dayId/assignments/reorder', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId, dayId } = req.params;
  const { orderedIds } = req.body;

  const day = db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(dayId, tripId);
  if (!day) return res.status(404).json({ error: 'Day not found' });

  const update = db.prepare('UPDATE day_assignments SET order_index = ? WHERE id = ? AND day_id = ?');
  db.exec('BEGIN');
  try {
    orderedIds.forEach((id: number, index: number) => {
      update.run(index, id, dayId);
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ success: true });
  broadcast(tripId, 'assignment:reordered', { dayId: Number(dayId), orderedIds }, req.headers['x-socket-id'] as string);
});

router.put('/trips/:tripId/assignments/:id/move', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId, id } = req.params;
  const { new_day_id, order_index } = req.body;

  const assignment = db.prepare(`
    SELECT da.* FROM day_assignments da
    JOIN days d ON da.day_id = d.id
    WHERE da.id = ? AND d.trip_id = ?
  `).get(id, tripId) as DayAssignment | undefined;

  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  const newDay = db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(new_day_id, tripId);
  if (!newDay) return res.status(404).json({ error: 'Target day not found' });

  const oldDayId = assignment.day_id;
  db.prepare('UPDATE day_assignments SET day_id = ?, order_index = ? WHERE id = ?').run(new_day_id, order_index || 0, id);

  const updated = getAssignmentWithPlace(Number(id));
  res.json({ assignment: updated });
  broadcast(tripId, 'assignment:moved', { assignment: updated, oldDayId: Number(oldDayId), newDayId: Number(new_day_id) }, req.headers['x-socket-id'] as string);
});

router.get('/trips/:tripId/assignments/:id/participants', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId, id } = req.params;

  const participants = db.prepare(`
    SELECT ap.user_id, u.username, u.avatar
    FROM assignment_participants ap
    JOIN users u ON ap.user_id = u.id
    WHERE ap.assignment_id = ?
  `).all(id);

  res.json({ participants });
});

router.put('/trips/:tripId/assignments/:id/time', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId, id } = req.params;

  const assignment = db.prepare(`
    SELECT da.* FROM day_assignments da
    JOIN days d ON da.day_id = d.id
    WHERE da.id = ? AND d.trip_id = ?
  `).get(id, tripId);
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  const { place_time, end_time, duration_minutes } = req.body;
  const row = assignment as Record<string, unknown>;
  db.prepare('UPDATE day_assignments SET assignment_time = ?, assignment_end_time = ?, duration_minutes = ? WHERE id = ?')
    .run(
      'place_time' in req.body ? (place_time ?? null) : (row.assignment_time ?? null),
      'end_time' in req.body ? (end_time ?? null) : (row.assignment_end_time ?? null),
      'duration_minutes' in req.body ? (duration_minutes ?? null) : (row.duration_minutes ?? null),
      id
    );

  const updated = getAssignmentWithPlace(Number(id));
  res.json({ assignment: updated });
  broadcast(Number(tripId), 'assignment:updated', { assignment: updated }, req.headers['x-socket-id'] as string);
});

router.put('/trips/:tripId/assignments/:id/participants', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId, id } = req.params;

  const { user_ids } = req.body;
  if (!Array.isArray(user_ids)) return res.status(400).json({ error: 'user_ids must be an array' });

  db.prepare('DELETE FROM assignment_participants WHERE assignment_id = ?').run(id);
  if (user_ids.length > 0) {
    const insert = db.prepare('INSERT OR IGNORE INTO assignment_participants (assignment_id, user_id) VALUES (?, ?)');
    for (const userId of user_ids) insert.run(id, userId);
  }

  const participants = db.prepare(`
    SELECT ap.user_id, u.username, u.avatar
    FROM assignment_participants ap
    JOIN users u ON ap.user_id = u.id
    WHERE ap.assignment_id = ?
  `).all(id);

  res.json({ participants });
  broadcast(Number(tripId), 'assignment:participants', { assignmentId: Number(id), participants }, req.headers['x-socket-id'] as string);
});

// Set price for an assignment and auto-manage linked budget item
router.put('/trips/:tripId/assignments/:id/price', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId, id } = req.params;
  const { price } = req.body;

  const assignment = db.prepare(`
    SELECT da.*, p.name as place_name, p.category_id,
      COALESCE(da.duration_minutes, p.duration_minutes) as duration_minutes,
      c.name as category_name
    FROM day_assignments da
    JOIN places p ON da.place_id = p.id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE da.id = ? AND da.day_id IN (SELECT id FROM days WHERE trip_id = ?)
  `).get(id, tripId) as Record<string, any> | undefined;
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  const numericPrice = typeof price === 'number' && isFinite(price) && price > 0 ? price : null;

  if (numericPrice !== null) {
    const categoryName = assignment.category_name || 'Other';
    if (assignment.budget_item_id) {
      // Update existing budget item
      db.prepare('UPDATE budget_items SET total_price = ?, name = ?, category = ? WHERE id = ?')
        .run(numericPrice, assignment.place_name, categoryName, assignment.budget_item_id);
    } else {
      // Create new budget item
      const maxOrder = (db.prepare('SELECT MAX(sort_order) as max_order FROM budget_items WHERE trip_id = ?').get(tripId) as any)?.max_order || 0;
      const result = db.prepare('INSERT INTO budget_items (trip_id, category, name, total_price, sort_order) VALUES (?, ?, ?, ?, ?)')
        .run(tripId, categoryName, assignment.place_name, numericPrice, maxOrder + 1);
      db.prepare('UPDATE day_assignments SET budget_item_id = ? WHERE id = ?')
        .run(result.lastInsertRowid, id);
    }
  } else {
    // Remove linked budget item
    if (assignment.budget_item_id) {
      db.prepare('DELETE FROM budget_items WHERE id = ?').run(assignment.budget_item_id);
      db.prepare('UPDATE day_assignments SET budget_item_id = NULL WHERE id = ?').run(id);
    }
  }

  const updated = getAssignmentWithPlace(Number(id));
  broadcast(Number(tripId), 'assignment:updated', { assignment: updated }, req.headers['x-socket-id'] as string);
  broadcast(Number(tripId), 'budget:updated', {}, req.headers['x-socket-id'] as string);
  res.json({ assignment: updated });
});

export default router;
