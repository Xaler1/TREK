import express, { Request, Response } from 'express';
import { db } from '../db/database';
import { authenticate } from '../middleware/auth';
import { requireTripAccess } from '../middleware/tripAccess';
import { broadcast } from '../websocket';
import { loadTagsByPlaceIds, loadParticipantsByAssignmentIds, formatAssignmentWithPlace } from '../services/queryHelpers';
import { AuthRequest, AssignmentRow, Day, DayNote } from '../types';

const router = express.Router({ mergeParams: true });

interface TripDayRow extends Day {
  date: string | null;
  title: string | null;
  notes: string | null;
}

interface TripDateRangeRow {
  start_date: string | null;
  end_date: string | null;
}

interface AccommodationLinkRow {
  id: number;
  start_day_id: number;
  end_day_id: number;
  place_name: string;
  price: number | null;
  budget_item_id: number | null;
}

interface ReservationLinkRow {
  id: number;
  reservation_time: string | null;
  reservation_end_time: string | null;
}

function shiftIsoDate(value: string, deltaDays: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().split('T')[0];
}

function shiftReservationDateValue(value: string | null, deltaDays: number): string | null {
  if (!value || deltaDays === 0) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return shiftIsoDate(value, deltaDays);
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return `${shiftIsoDate(value.slice(0, 10), deltaDays)}${value.slice(10)}`;
  }
  return value;
}

function replaceReservationDateValue(value: string | null, newDate: string | null): string | null {
  if (!newDate) return value;
  if (!value) return newDate;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return newDate;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return `${newDate}${value.slice(10)}`;
  return value;
}

function loadTripDays(tripId: number | string) {
  return db.prepare('SELECT * FROM days WHERE trip_id = ? ORDER BY day_number ASC').all(tripId) as TripDayRow[];
}

function updateReservationsForShiftedDays(dayDeltas: Map<number, number>): void {
  if (dayDeltas.size === 0) return;

  const reservations = db.prepare(
    `SELECT id, day_id, reservation_time, reservation_end_time
     FROM reservations
     WHERE day_id IS NOT NULL`
  ).all() as Array<{ id: number; day_id: number; reservation_time: string | null; reservation_end_time: string | null }>;

  const updateReservation = db.prepare(
    'UPDATE reservations SET reservation_time = ?, reservation_end_time = ? WHERE id = ?'
  );

  for (const reservation of reservations) {
    const delta = dayDeltas.get(reservation.day_id);
    if (!delta) continue;

    const nextReservationTime = shiftReservationDateValue(reservation.reservation_time, delta);
    const nextReservationEndTime = shiftReservationDateValue(reservation.reservation_end_time, delta);

    if (
      nextReservationTime !== reservation.reservation_time
      || nextReservationEndTime !== reservation.reservation_end_time
    ) {
      updateReservation.run(nextReservationTime, nextReservationEndTime, reservation.id);
    }
  }
}

function syncAccommodationReferences(tripId: number | string): void {
  const daysById = new Map(loadTripDays(tripId).map(day => [day.id, day]));
  const accommodations = db.prepare(`
    SELECT a.id, a.start_day_id, a.end_day_id, a.price, a.budget_item_id, p.name as place_name
    FROM day_accommodations a
    JOIN places p ON p.id = a.place_id
    WHERE a.trip_id = ?
  `).all(tripId) as AccommodationLinkRow[];

  const updateBudgetWithPrice = db.prepare(
    'UPDATE budget_items SET total_price = ?, days = ?, name = ? WHERE id = ?'
  );
  const updateBudgetWithoutPrice = db.prepare(
    'UPDATE budget_items SET days = ?, name = ? WHERE id = ?'
  );
  const updateReservation = db.prepare(
    'UPDATE reservations SET day_id = ?, reservation_time = ? WHERE id = ?'
  );

  for (const accommodation of accommodations) {
    const startDay = daysById.get(accommodation.start_day_id);
    const endDay = daysById.get(accommodation.end_day_id);
    if (!startDay || !endDay) continue;

    const nights = Math.max(1, endDay.day_number - startDay.day_number);

    if (accommodation.budget_item_id) {
      if (accommodation.price) {
        updateBudgetWithPrice.run(accommodation.price * nights, nights, accommodation.place_name, accommodation.budget_item_id);
      } else {
        updateBudgetWithoutPrice.run(nights, accommodation.place_name, accommodation.budget_item_id);
      }
    }

    const linkedReservations = db.prepare(
      'SELECT id, reservation_time, reservation_end_time FROM reservations WHERE accommodation_id = ?'
    ).all(accommodation.id) as ReservationLinkRow[];

    for (const reservation of linkedReservations) {
      const nextReservationTime = replaceReservationDateValue(reservation.reservation_time, startDay.date);
      updateReservation.run(accommodation.start_day_id, nextReservationTime, reservation.id);
    }
  }
}

function deleteAccommodationCascade(accommodationId: number): void {
  const accommodation = db.prepare(
    'SELECT budget_item_id FROM day_accommodations WHERE id = ?'
  ).get(accommodationId) as { budget_item_id: number | null } | undefined;
  if (!accommodation) return;

  if (accommodation.budget_item_id) {
    db.prepare('DELETE FROM budget_items WHERE id = ?').run(accommodation.budget_item_id);
  }

  const linkedReservation = db.prepare(
    'SELECT id FROM reservations WHERE accommodation_id = ?'
  ).get(accommodationId) as { id: number } | undefined;
  if (linkedReservation) {
    db.prepare('DELETE FROM reservations WHERE id = ?').run(linkedReservation.id);
  }

  db.prepare('DELETE FROM day_accommodations WHERE id = ?').run(accommodationId);
}

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
  const { date, notes, title, after_day_id } = req.body;

  const trip = db.prepare('SELECT start_date, end_date FROM trips WHERE id = ?').get(tripId) as TripDateRangeRow | undefined;
  if (!trip) {
    return res.status(404).json({ error: 'Trip not found' });
  }

  db.exec('BEGIN');
  try {
    let dayNumber: number;
    let nextDate: string | null = date || null;
    const shiftedDays = new Map<number, number>();

    if (after_day_id !== undefined && after_day_id !== null) {
      const anchorDay = db.prepare('SELECT * FROM days WHERE id = ? AND trip_id = ?').get(after_day_id, tripId) as TripDayRow | undefined;
      if (!anchorDay) {
        db.exec('ROLLBACK');
        return res.status(404).json({ error: 'Day not found' });
      }

      dayNumber = anchorDay.day_number + 1;
      if (date === undefined) {
        nextDate = anchorDay.date ? shiftIsoDate(anchorDay.date, 1) : null;
      }

      const laterDays = db.prepare(
        'SELECT id, day_number, date FROM days WHERE trip_id = ? AND day_number > ? ORDER BY day_number ASC'
      ).all(tripId, anchorDay.day_number) as Array<{ id: number; day_number: number; date: string | null }>;

      const setTempDayNumber = db.prepare('UPDATE days SET day_number = ? WHERE id = ?');
      const updateShiftedDay = db.prepare('UPDATE days SET day_number = ?, date = ? WHERE id = ?');

      laterDays.forEach((entry, index) => setTempDayNumber.run(-(index + 1), entry.id));
      for (const entry of laterDays) {
        updateShiftedDay.run(
          entry.day_number + 1,
          entry.date ? shiftIsoDate(entry.date, 1) : null,
          entry.id,
        );
        shiftedDays.set(entry.id, 1);
      }

      if (trip.end_date) {
        db.prepare('UPDATE trips SET end_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(shiftIsoDate(trip.end_date, 1), tripId);
      }
    } else {
      const maxDay = db.prepare('SELECT MAX(day_number) as max FROM days WHERE trip_id = ?').get(tripId) as { max: number | null };
      dayNumber = (maxDay.max || 0) + 1;
      if (date === undefined && trip.end_date) {
        nextDate = shiftIsoDate(trip.end_date, 1);
        db.prepare('UPDATE trips SET end_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(nextDate, tripId);
      }
    }

    const result = db.prepare(
      'INSERT INTO days (trip_id, day_number, date, notes, title) VALUES (?, ?, ?, ?, ?)'
    ).run(tripId, dayNumber, nextDate, notes || null, title || null);

    updateReservationsForShiftedDays(shiftedDays);
    syncAccommodationReferences(tripId);

    db.exec('COMMIT');

    const day = db.prepare('SELECT * FROM days WHERE id = ?').get(result.lastInsertRowid) as TripDayRow;
    const dayResult = { ...day, assignments: [], notes_items: [] };

    res.status(201).json({ day: dayResult });
    broadcast(tripId, 'day:created', { day: dayResult }, req.headers['x-socket-id'] as string);

    if (shiftedDays.size > 0) {
      const shiftedDayRows = loadTripDays(tripId).filter(entry => shiftedDays.has(entry.id));
      for (const shiftedDay of shiftedDayRows) {
        broadcast(tripId, 'day:updated', { day: shiftedDay }, req.headers['x-socket-id'] as string);
      }
    }
  } catch (error) {
    db.exec('ROLLBACK');
    console.error('Failed to insert day:', error);
    res.status(500).json({ error: 'Failed to insert day' });
  }
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

  const day = db.prepare('SELECT * FROM days WHERE id = ? AND trip_id = ?').get(id, tripId) as TripDayRow | undefined;
  if (!day) {
    return res.status(404).json({ error: 'Day not found' });
  }

  const dayCount = db.prepare('SELECT COUNT(*) as count FROM days WHERE trip_id = ?').get(tripId) as { count: number };
  if (dayCount.count <= 1) {
    return res.status(400).json({ error: 'At least one day must remain' });
  }

  const trip = db.prepare('SELECT start_date, end_date FROM trips WHERE id = ?').get(tripId) as TripDateRangeRow | undefined;
  if (!trip) {
    return res.status(404).json({ error: 'Trip not found' });
  }

  db.exec('BEGIN');
  try {
    const previousDay = db.prepare(
      'SELECT id FROM days WHERE trip_id = ? AND day_number = ?'
    ).get(tripId, day.day_number - 1) as { id: number } | undefined;
    const nextDay = db.prepare(
      'SELECT id FROM days WHERE trip_id = ? AND day_number = ?'
    ).get(tripId, day.day_number + 1) as { id: number } | undefined;

    const accommodationsToAdjust = db.prepare(
      'SELECT id, start_day_id, end_day_id FROM day_accommodations WHERE trip_id = ? AND (start_day_id = ? OR end_day_id = ?)'
    ).all(tripId, id, id) as Array<{ id: number; start_day_id: number; end_day_id: number }>;
    const updateAccommodationDays = db.prepare(
      'UPDATE day_accommodations SET start_day_id = ?, end_day_id = ? WHERE id = ?'
    );

    for (const accommodation of accommodationsToAdjust) {
      if (accommodation.start_day_id === Number(id) && accommodation.end_day_id === Number(id)) {
        deleteAccommodationCascade(accommodation.id);
        continue;
      }

      const newStartDayId = accommodation.start_day_id === Number(id)
        ? (nextDay?.id ?? previousDay?.id ?? accommodation.start_day_id)
        : accommodation.start_day_id;
      const newEndDayId = accommodation.end_day_id === Number(id)
        ? (previousDay?.id ?? nextDay?.id ?? accommodation.end_day_id)
        : accommodation.end_day_id;

      updateAccommodationDays.run(newStartDayId, newEndDayId, accommodation.id);
    }

    // Clean up budget items linked to assignments on this day
    const assignmentsToDelete = db.prepare('SELECT budget_item_id FROM day_assignments WHERE day_id = ? AND budget_item_id IS NOT NULL').all(id);
    for (const a of assignmentsToDelete as Array<{ budget_item_id: number }>) {
      db.prepare('DELETE FROM budget_items WHERE id = ?').run(a.budget_item_id);
    }

    db.prepare('DELETE FROM days WHERE id = ?').run(id);

    const laterDays = db.prepare(
      'SELECT id, day_number, date FROM days WHERE trip_id = ? AND day_number > ? ORDER BY day_number ASC'
    ).all(tripId, day.day_number) as Array<{ id: number; day_number: number; date: string | null }>;
    const shiftedDays = new Map<number, number>();
    const setTempDayNumber = db.prepare('UPDATE days SET day_number = ? WHERE id = ?');
    const updateShiftedDay = db.prepare('UPDATE days SET day_number = ?, date = ? WHERE id = ?');

    laterDays.forEach((entry, index) => setTempDayNumber.run(-(index + 1), entry.id));
    for (const entry of laterDays) {
      updateShiftedDay.run(
        entry.day_number - 1,
        entry.date ? shiftIsoDate(entry.date, -1) : null,
        entry.id,
      );
      shiftedDays.set(entry.id, -1);
    }

    if (trip.end_date) {
      db.prepare('UPDATE trips SET end_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(shiftIsoDate(trip.end_date, -1), tripId);
    }

    updateReservationsForShiftedDays(shiftedDays);
    syncAccommodationReferences(tripId);

    db.exec('COMMIT');

    const selectedDayId = nextDay?.id ?? previousDay?.id ?? null;
    res.json({ success: true, selected_day_id: selectedDayId });
    broadcast(tripId, 'day:deleted', { dayId: Number(id) }, req.headers['x-socket-id'] as string);

    if (shiftedDays.size > 0) {
      const shiftedDayRows = loadTripDays(tripId).filter(entry => shiftedDays.has(entry.id));
      for (const shiftedDay of shiftedDayRows) {
        broadcast(tripId, 'day:updated', { day: shiftedDay }, req.headers['x-socket-id'] as string);
      }
    }
  } catch (error) {
    db.exec('ROLLBACK');
    console.error('Failed to delete day:', error);
    res.status(500).json({ error: 'Failed to delete day' });
  }
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
