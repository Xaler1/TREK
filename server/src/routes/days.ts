import express, { Request, Response } from 'express';
import { db } from '../db/database';
import { authenticate } from '../middleware/auth';
import { requireTripAccess } from '../middleware/tripAccess';
import { broadcast } from '../websocket';
import { loadTagsByPlaceIds, loadParticipantsByAssignmentIds, formatAssignmentWithPlace } from '../services/queryHelpers';
import { AuthRequest, AssignmentRow, Day, DayNote } from '../types';

const router = express.Router({ mergeParams: true });

function getAssignmentsForDay(dayId: number | string) {
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

  return assignments.map(a => {
    const tags = db.prepare(`
      SELECT t.* FROM tags t
      JOIN place_tags pt ON t.id = pt.tag_id
      WHERE pt.place_id = ?
    `).all(a.place_id);

    return {
      id: a.id,
      day_id: a.day_id,
      order_index: a.order_index,
      notes: a.notes,
      created_at: a.created_at,
      budget_item_id: a.budget_item_id,
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
  });
}

router.get('/', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId } = req.params;

  const days = db.prepare('SELECT * FROM days WHERE trip_id = ? ORDER BY day_number ASC').all(tripId) as Day[];

  if (days.length === 0) {
    return res.json({ days: [] });
  }

  const dayIds = days.map(d => d.id);
  const dayPlaceholders = dayIds.map(() => '?').join(',');

  const allAssignments = db.prepare(`
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
    WHERE da.day_id IN (${dayPlaceholders})
    ORDER BY da.order_index ASC, da.created_at ASC
  `).all(...dayIds) as AssignmentRow[];

  const placeIds = [...new Set(allAssignments.map(a => a.place_id))];
  const tagsByPlaceId = loadTagsByPlaceIds(placeIds, { compact: true });

  const allAssignmentIds = allAssignments.map(a => a.id);
  const participantsByAssignment = loadParticipantsByAssignmentIds(allAssignmentIds);

  const assignmentsByDayId: Record<number, ReturnType<typeof formatAssignmentWithPlace>[]> = {};
  for (const a of allAssignments) {
    if (!assignmentsByDayId[a.day_id]) assignmentsByDayId[a.day_id] = [];
    assignmentsByDayId[a.day_id].push(formatAssignmentWithPlace(a, tagsByPlaceId[a.place_id] || [], participantsByAssignment[a.id] || []));
  }

  const allNotes = db.prepare(
    `SELECT * FROM day_notes WHERE day_id IN (${dayPlaceholders}) ORDER BY sort_order ASC, created_at ASC`
  ).all(...dayIds) as DayNote[];
  const notesByDayId: Record<number, DayNote[]> = {};
  for (const note of allNotes) {
    if (!notesByDayId[note.day_id]) notesByDayId[note.day_id] = [];
    notesByDayId[note.day_id].push(note);
  }

  const daysWithAssignments = days.map(day => ({
    ...day,
    assignments: assignmentsByDayId[day.id] || [],
    notes_items: notesByDayId[day.id] || [],
  }));

  res.json({ days: daysWithAssignments });
});

router.post('/', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId } = req.params;
  const { date, notes } = req.body;

  const maxDay = db.prepare('SELECT MAX(day_number) as max FROM days WHERE trip_id = ?').get(tripId) as { max: number | null };
  const dayNumber = (maxDay.max || 0) + 1;

  const result = db.prepare(
    'INSERT INTO days (trip_id, day_number, date, notes) VALUES (?, ?, ?, ?)'
  ).run(tripId, dayNumber, date || null, notes || null);

  const day = db.prepare('SELECT * FROM days WHERE id = ?').get(result.lastInsertRowid) as Day;

  const dayResult = { ...day, assignments: [] };
  res.status(201).json({ day: dayResult });
  broadcast(tripId, 'day:created', { day: dayResult }, req.headers['x-socket-id'] as string);
});

router.put('/:id', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId, id } = req.params;

  const day = db.prepare('SELECT * FROM days WHERE id = ? AND trip_id = ?').get(id, tripId) as Day | undefined;
  if (!day) {
    return res.status(404).json({ error: 'Day not found' });
  }

  const { notes, title } = req.body;
  db.prepare('UPDATE days SET notes = ?, title = ? WHERE id = ?').run(notes || null, title !== undefined ? title : day.title, id);

  const updatedDay = db.prepare('SELECT * FROM days WHERE id = ?').get(id) as Day;
  const dayWithAssignments = { ...updatedDay, assignments: getAssignmentsForDay(id) };
  res.json({ day: dayWithAssignments });
  broadcast(tripId, 'day:updated', { day: dayWithAssignments }, req.headers['x-socket-id'] as string);
});

router.delete('/:id', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId, id } = req.params;

  const day = db.prepare('SELECT * FROM days WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!day) {
    return res.status(404).json({ error: 'Day not found' });
  }

  // Clean up budget items linked to assignments on this day
  const assignmentsToDelete = db.prepare('SELECT budget_item_id FROM day_assignments WHERE day_id = ? AND budget_item_id IS NOT NULL').all(id);
  for (const a of assignmentsToDelete as any[]) {
    db.prepare('DELETE FROM budget_items WHERE id = ?').run(a.budget_item_id);
  }

  db.prepare('DELETE FROM days WHERE id = ?').run(id);
  res.json({ success: true });
  broadcast(tripId, 'day:deleted', { dayId: Number(id) }, req.headers['x-socket-id'] as string);
});

const accommodationsRouter = express.Router({ mergeParams: true });

function getAccommodationWithPlace(id: number | bigint) {
  return db.prepare(`
    SELECT a.*, a.budget_item_id, a.price, p.name as place_name, p.address as place_address, p.image_url as place_image, p.lat as place_lat, p.lng as place_lng
    FROM day_accommodations a
    JOIN places p ON a.place_id = p.id
    WHERE a.id = ?
  `).get(id);
}

accommodationsRouter.get('/', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId } = req.params;

  const accommodations = db.prepare(`
    SELECT a.*, a.budget_item_id, a.price, p.name as place_name, p.address as place_address, p.image_url as place_image, p.lat as place_lat, p.lng as place_lng
    FROM day_accommodations a
    JOIN places p ON a.place_id = p.id
    WHERE a.trip_id = ?
    ORDER BY a.created_at ASC
  `).all(tripId);

  res.json({ accommodations });
});

accommodationsRouter.post('/', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId } = req.params;
  const { place_id, start_day_id, end_day_id, check_in, check_out, confirmation, notes } = req.body;

  if (!place_id || !start_day_id || !end_day_id) {
    return res.status(400).json({ error: 'place_id, start_day_id, and end_day_id are required' });
  }

  const place = db.prepare('SELECT id FROM places WHERE id = ? AND trip_id = ?').get(place_id, tripId);
  if (!place) return res.status(404).json({ error: 'Place not found' });

  const startDay = db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(start_day_id, tripId);
  if (!startDay) return res.status(404).json({ error: 'Start day not found' });

  const endDay = db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(end_day_id, tripId);
  if (!endDay) return res.status(404).json({ error: 'End day not found' });

  const result = db.prepare(
    'INSERT INTO day_accommodations (trip_id, place_id, start_day_id, end_day_id, check_in, check_out, confirmation, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(tripId, place_id, start_day_id, end_day_id, check_in || null, check_out || null, confirmation || null, notes || null);

  const accommodationId = result.lastInsertRowid;

  // Auto-create linked reservation for this accommodation
  const placeName = (db.prepare('SELECT name FROM places WHERE id = ?').get(place_id) as { name: string } | undefined)?.name || 'Hotel';
  const startDayDate = (db.prepare('SELECT date FROM days WHERE id = ?').get(start_day_id) as { date: string } | undefined)?.date || null;
  const meta: Record<string, string> = {};
  if (check_in) meta.check_in_time = check_in;
  if (check_out) meta.check_out_time = check_out;
  db.prepare(`
    INSERT INTO reservations (trip_id, day_id, title, reservation_time, location, confirmation_number, notes, status, type, accommodation_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', 'hotel', ?, ?)
  `).run(
    tripId, start_day_id, placeName, startDayDate || null, null,
    confirmation || null, notes || null, accommodationId,
    Object.keys(meta).length > 0 ? JSON.stringify(meta) : null
  );

  const accommodation = getAccommodationWithPlace(accommodationId);
  res.status(201).json({ accommodation });
  broadcast(tripId, 'accommodation:created', { accommodation }, req.headers['x-socket-id'] as string);
  broadcast(tripId, 'reservation:created', {}, req.headers['x-socket-id'] as string);
});

accommodationsRouter.put('/:id', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId, id } = req.params;

  interface DayAccommodation { id: number; trip_id: number; place_id: number; start_day_id: number; end_day_id: number; check_in: string | null; check_out: string | null; confirmation: string | null; notes: string | null; }
  const existing = db.prepare('SELECT * FROM day_accommodations WHERE id = ? AND trip_id = ?').get(id, tripId) as DayAccommodation | undefined;
  if (!existing) return res.status(404).json({ error: 'Accommodation not found' });

  const { place_id, start_day_id, end_day_id, check_in, check_out, confirmation, notes } = req.body;

  const newPlaceId = place_id !== undefined ? place_id : existing.place_id;
  const newStartDayId = start_day_id !== undefined ? start_day_id : existing.start_day_id;
  const newEndDayId = end_day_id !== undefined ? end_day_id : existing.end_day_id;
  const newCheckIn = check_in !== undefined ? check_in : existing.check_in;
  const newCheckOut = check_out !== undefined ? check_out : existing.check_out;
  const newConfirmation = confirmation !== undefined ? confirmation : existing.confirmation;
  const newNotes = notes !== undefined ? notes : existing.notes;

  if (place_id !== undefined) {
    const place = db.prepare('SELECT id FROM places WHERE id = ? AND trip_id = ?').get(place_id, tripId);
    if (!place) return res.status(404).json({ error: 'Place not found' });
  }

  if (start_day_id !== undefined) {
    const startDay = db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(start_day_id, tripId);
    if (!startDay) return res.status(404).json({ error: 'Start day not found' });
  }

  if (end_day_id !== undefined) {
    const endDay = db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(end_day_id, tripId);
    if (!endDay) return res.status(404).json({ error: 'End day not found' });
  }

  db.prepare(
    'UPDATE day_accommodations SET place_id = ?, start_day_id = ?, end_day_id = ?, check_in = ?, check_out = ?, confirmation = ?, notes = ? WHERE id = ?'
  ).run(newPlaceId, newStartDayId, newEndDayId, newCheckIn, newCheckOut, newConfirmation, newNotes, id);

  // Recalculate linked budget item if dates or price changed
  const updatedAcc = db.prepare('SELECT * FROM day_accommodations WHERE id = ?').get(id) as Record<string, any>;
  if (updatedAcc?.budget_item_id && updatedAcc?.price) {
    const sDay = db.prepare('SELECT day_number FROM days WHERE id = ?').get(updatedAcc.start_day_id) as { day_number: number } | undefined;
    const eDay = db.prepare('SELECT day_number FROM days WHERE id = ?').get(updatedAcc.end_day_id) as { day_number: number } | undefined;
    const nights = (sDay && eDay) ? Math.max(1, eDay.day_number - sDay.day_number) : 1;
    db.prepare('UPDATE budget_items SET total_price = ?, days = ? WHERE id = ?')
      .run(updatedAcc.price * nights, nights, updatedAcc.budget_item_id);
  }

  // Sync check-in/out/confirmation to linked reservation
  const linkedRes = db.prepare('SELECT id, metadata FROM reservations WHERE accommodation_id = ?').get(Number(id)) as { id: number; metadata: string | null } | undefined;
  if (linkedRes) {
    const meta = linkedRes.metadata ? JSON.parse(linkedRes.metadata) : {};
    if (newCheckIn) meta.check_in_time = newCheckIn;
    if (newCheckOut) meta.check_out_time = newCheckOut;
    db.prepare('UPDATE reservations SET metadata = ?, confirmation_number = COALESCE(?, confirmation_number) WHERE id = ?')
      .run(JSON.stringify(meta), newConfirmation || null, linkedRes.id);
  }

  const accommodation = getAccommodationWithPlace(Number(id));
  res.json({ accommodation });
  broadcast(tripId, 'accommodation:updated', { accommodation }, req.headers['x-socket-id'] as string);
});

accommodationsRouter.delete('/:id', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId, id } = req.params;

  const existing = db.prepare('SELECT * FROM day_accommodations WHERE id = ? AND trip_id = ?').get(id, tripId) as Record<string, any> | undefined;
  if (!existing) return res.status(404).json({ error: 'Accommodation not found' });

  // Delete linked budget item
  if (existing.budget_item_id) {
    db.prepare('DELETE FROM budget_items WHERE id = ?').run(existing.budget_item_id);
  }

  // Delete linked reservation
  const linkedRes = db.prepare('SELECT id FROM reservations WHERE accommodation_id = ?').get(Number(id)) as { id: number } | undefined;
  if (linkedRes) {
    db.prepare('DELETE FROM reservations WHERE id = ?').run(linkedRes.id);
    broadcast(tripId, 'reservation:deleted', { reservationId: linkedRes.id }, req.headers['x-socket-id'] as string);
  }

  db.prepare('DELETE FROM day_accommodations WHERE id = ?').run(id);
  res.json({ success: true });
  broadcast(tripId, 'accommodation:deleted', { accommodationId: Number(id) }, req.headers['x-socket-id'] as string);
});

// Set price for accommodation and auto-manage linked budget item
accommodationsRouter.put('/:id/price', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId, id } = req.params;
  const { price } = req.body;

  const accommodation = db.prepare(`
    SELECT a.*, p.name as place_name
    FROM day_accommodations a
    JOIN places p ON a.place_id = p.id
    WHERE a.id = ? AND a.trip_id = ?
  `).get(id, tripId) as Record<string, any> | undefined;
  if (!accommodation) return res.status(404).json({ error: 'Accommodation not found' });

  // Calculate number of nights from day numbers
  const startDay = db.prepare('SELECT day_number FROM days WHERE id = ?').get(accommodation.start_day_id) as { day_number: number } | undefined;
  const endDay = db.prepare('SELECT day_number FROM days WHERE id = ?').get(accommodation.end_day_id) as { day_number: number } | undefined;
  const nights = (startDay && endDay) ? Math.max(1, endDay.day_number - startDay.day_number) : 1;

  const numericPrice = typeof price === 'number' && isFinite(price) && price > 0 ? price : null;

  if (numericPrice !== null) {
    const totalPrice = numericPrice * nights;
    db.prepare('UPDATE day_accommodations SET price = ? WHERE id = ?').run(numericPrice, id);

    if (accommodation.budget_item_id) {
      db.prepare('UPDATE budget_items SET total_price = ?, name = ? WHERE id = ?')
        .run(totalPrice, accommodation.place_name, accommodation.budget_item_id);
    } else {
      const maxOrder = (db.prepare('SELECT MAX(sort_order) as max_order FROM budget_items WHERE trip_id = ?').get(tripId) as any)?.max_order || 0;
      const result = db.prepare('INSERT INTO budget_items (trip_id, category, name, total_price, days, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
        .run(tripId, 'Accommodation', accommodation.place_name, totalPrice, nights, maxOrder + 1);
      db.prepare('UPDATE day_accommodations SET budget_item_id = ? WHERE id = ?')
        .run(result.lastInsertRowid, id);
    }
  } else {
    db.prepare('UPDATE day_accommodations SET price = NULL WHERE id = ?').run(id);
    if (accommodation.budget_item_id) {
      db.prepare('DELETE FROM budget_items WHERE id = ?').run(accommodation.budget_item_id);
      db.prepare('UPDATE day_accommodations SET budget_item_id = NULL WHERE id = ?').run(id);
    }
  }

  const updated = getAccommodationWithPlace(Number(id));
  broadcast(Number(tripId), 'accommodation:updated', { accommodation: updated }, req.headers['x-socket-id'] as string);
  broadcast(Number(tripId), 'budget:updated', {}, req.headers['x-socket-id'] as string);
  res.json({ accommodation: updated });
});

export default router;
export { accommodationsRouter };
