import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { db, canAccessTrip, isOwner } from '../db/database';
import { authenticate, demoUploadBlock } from '../middleware/auth';
import { broadcast } from '../websocket';
import { AuthRequest, Trip, User } from '../types';

const router = express.Router();

const MS_PER_DAY = 86400000;
const MAX_TRIP_DAYS = 90;
const MAX_COVER_SIZE = 20 * 1024 * 1024; // 20 MB

const uploadsDir = path.join(__dirname, '../../uploads');
const coversDir = path.join(__dirname, '../../uploads/covers');
const filesDir = path.join(__dirname, '../../uploads/files');
const legacyPhotosDir = path.join(__dirname, '../../uploads/photos');
const coverStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    if (!fs.existsSync(coversDir)) fs.mkdirSync(coversDir, { recursive: true });
    cb(null, coversDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const uploadCover = multer({
  storage: coverStorage,
  limits: { fileSize: MAX_COVER_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    if (file.mimetype.startsWith('image/') && !file.mimetype.includes('svg') && allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only jpg, png, gif, webp images allowed'));
    }
  },
});

const TRIP_SELECT = `
  SELECT t.*,
    (SELECT COUNT(*) FROM days d WHERE d.trip_id = t.id) as day_count,
    (SELECT COUNT(*) FROM places p WHERE p.trip_id = t.id) as place_count,
    CASE WHEN t.user_id = :userId THEN 1 ELSE 0 END as is_owner,
    u.username as owner_username,
    (SELECT COUNT(*) FROM trip_members tm WHERE tm.trip_id = t.id) as shared_count
  FROM trips t
  JOIN users u ON u.id = t.user_id
`;

type SqlRow = Record<string, unknown>;

const tableColumnsCache = new Map<string, string[]>();

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function cleanupCreatedFiles(filePaths: string[]): void {
  for (const filePath of filePaths) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
  }
}

function resolveScopedUploadPath(uploadUrl: string, relativePrefix: string): string | null {
  const normalized = uploadUrl.replace(/\\/g, '/');
  const expectedPrefix = `/uploads/${relativePrefix}/`;
  if (!normalized.startsWith(expectedPrefix)) return null;

  const sourcePath = path.resolve(__dirname, '../../', normalized.replace(/^\//, ''));
  const scopeRoot = path.resolve(path.join(uploadsDir, relativePrefix));
  const scopePrefix = `${scopeRoot}${path.sep}`;
  if (sourcePath !== scopeRoot && !sourcePath.startsWith(scopePrefix)) return null;
  return sourcePath;
}

function normalizeCoverImageValue(coverImage: unknown): { valid: boolean; value: string | null } {
  if (coverImage == null) return { valid: true, value: null };
  if (typeof coverImage !== 'string') return { valid: false, value: null };

  const trimmed = coverImage.trim();
  if (!trimmed) return { valid: true, value: null };
  if (/^https?:\/\//i.test(trimmed)) return { valid: true, value: trimmed };
  if (resolveScopedUploadPath(trimmed, 'covers')) return { valid: true, value: trimmed.replace(/\\/g, '/') };
  return { valid: false, value: null };
}

function tableExists(table: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function getTableColumns(table: string): string[] {
  if (!tableExists(table)) return [];
  if (tableColumnsCache.has(table)) return tableColumnsCache.get(table)!;

  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as { name: string }[];
  const columns = rows.map((row) => row.name);
  tableColumnsCache.set(table, columns);
  return columns;
}

function buildInsertRow(table: string, sourceRow: SqlRow, overrides: SqlRow = {}, exclude: string[] = []): SqlRow {
  const row: SqlRow = {};
  const excluded = new Set(['id', ...exclude]);

  for (const column of getTableColumns(table)) {
    if (excluded.has(column)) continue;

    if (Object.prototype.hasOwnProperty.call(overrides, column)) {
      const overrideValue = overrides[column];
      if (overrideValue !== undefined) row[column] = overrideValue;
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(sourceRow, column)) {
      const value = sourceRow[column];
      if (value !== undefined) row[column] = value;
    }
  }

  return row;
}

function insertDynamic(table: string, row: SqlRow): number {
  const columns = Object.keys(row);
  if (columns.length === 0) {
    const result = db.prepare(`INSERT INTO ${quoteIdentifier(table)} DEFAULT VALUES`).run();
    return Number(result.lastInsertRowid);
  }

  const columnSql = columns.map((column) => quoteIdentifier(column)).join(', ');
  const valueSql = columns.map((column) => `@${column}`).join(', ');
  const result = db.prepare(`INSERT INTO ${quoteIdentifier(table)} (${columnSql}) VALUES (${valueSql})`).run(row);
  return Number(result.lastInsertRowid);
}

function cloneUploadUrl(uploadUrl: string | null | undefined, storageDir: string, relativePrefix: string, createdFiles: string[]): string | null {
  if (!uploadUrl) return null;

  const normalized = uploadUrl.replace(/\\/g, '/');
  const expectedPrefix = `/uploads/${relativePrefix}/`;
  if (!normalized.startsWith(expectedPrefix)) return uploadUrl;

  const sourcePath = resolveScopedUploadPath(normalized, relativePrefix);
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;

  ensureDirectory(storageDir);
  const ext = path.extname(normalized);
  const fileName = `${uuidv4()}${ext}`;
  const targetPath = path.join(storageDir, fileName);
  fs.copyFileSync(sourcePath, targetPath);
  createdFiles.push(targetPath);
  return `${expectedPrefix}${fileName}`;
}

function cloneStoredAsset(storedValue: string | null | undefined, storageDir: string, storagePrefix: string, createdFiles: string[]): string | null {
  if (!storedValue) return null;

  const normalized = storedValue.replace(/\\/g, '/').replace(/^\/+/, '');
  const prefixed = normalized.startsWith(`${storagePrefix}/`);
  const sourcePath = prefixed ? path.join(uploadsDir, normalized) : path.join(storageDir, normalized);
  if (!fs.existsSync(sourcePath)) return storedValue;

  ensureDirectory(storageDir);
  const ext = path.extname(normalized);
  const fileName = `${uuidv4()}${ext}`;
  const targetPath = path.join(storageDir, fileName);
  fs.copyFileSync(sourcePath, targetPath);
  createdFiles.push(targetPath);
  return prefixed ? `${storagePrefix}/${fileName}` : fileName;
}

function buildDuplicateTripTitle(sourceTitle: string, userId: number): string {
  const exists = db.prepare('SELECT 1 FROM trips WHERE user_id = ? AND title = ? LIMIT 1');
  const baseTitle = `${sourceTitle} (Copy)`;
  let candidate = baseTitle;
  let copyNumber = 2;

  while (exists.get(userId, candidate)) {
    candidate = `${sourceTitle} (Copy ${copyNumber})`;
    copyNumber += 1;
  }

  return candidate;
}

function duplicateTrip(sourceTripId: string | number, userId: number, requestedTitle?: string): SqlRow {
  const sourceTrip = db.prepare('SELECT * FROM trips WHERE id = ? AND user_id = ?').get(sourceTripId, userId) as Trip | undefined;
  if (!sourceTrip) throw new Error('Trip not found');

  const createdFiles: string[] = [];
  db.exec('BEGIN');

  try {
    const nextTitle = requestedTitle?.trim() ? requestedTitle.trim() : buildDuplicateTripTitle(sourceTrip.title, userId);
    const sourceCover = normalizeCoverImageValue(sourceTrip.cover_image);
    const coverImage = sourceCover.valid ? cloneUploadUrl(sourceCover.value ?? null, coversDir, 'covers', createdFiles) : null;
    const tripInsert = db.prepare(`
      INSERT INTO trips (user_id, title, description, start_date, end_date, currency, cover_image, is_archived)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      userId,
      nextTitle,
      sourceTrip.description ?? null,
      sourceTrip.start_date ?? null,
      sourceTrip.end_date ?? null,
      sourceTrip.currency,
      coverImage
    );

    const newTripId = Number(tripInsert.lastInsertRowid);
    const dayMap = new Map<number, number>();
    const placeMap = new Map<number, number>();
    const budgetItemMap = new Map<number, number>();
    const bagMap = new Map<number, number>();
    const assignmentMap = new Map<number, number>();
    const accommodationMap = new Map<number, number>();
    const collabNoteMap = new Map<number, number>();
    const reservationMap = new Map<number, number>();
    const pollMap = new Map<number, number>();
    const messageMap = new Map<number, number>();
    const fileMap = new Map<number, number>();

    const tripMembers = db.prepare('SELECT * FROM trip_members WHERE trip_id = ? ORDER BY id').all(sourceTripId) as SqlRow[];
    for (const member of tripMembers) {
      insertDynamic('trip_members', buildInsertRow('trip_members', member, { trip_id: newTripId }));
    }

    const days = db.prepare('SELECT * FROM days WHERE trip_id = ? ORDER BY day_number, id').all(sourceTripId) as SqlRow[];
    for (const day of days) {
      const oldId = Number(day.id);
      const newId = insertDynamic('days', buildInsertRow('days', day, { trip_id: newTripId }));
      dayMap.set(oldId, newId);
    }

    const places = db.prepare('SELECT * FROM places WHERE trip_id = ? ORDER BY id').all(sourceTripId) as SqlRow[];
    for (const place of places) {
      const oldId = Number(place.id);
      const newId = insertDynamic('places', buildInsertRow('places', place, { trip_id: newTripId }));
      placeMap.set(oldId, newId);
    }

    const placeTags = db.prepare(`
      SELECT pt.*
      FROM place_tags pt
      JOIN places p ON p.id = pt.place_id
      WHERE p.trip_id = ?
      ORDER BY pt.place_id, pt.tag_id
    `).all(sourceTripId) as SqlRow[];
    for (const placeTag of placeTags) {
      const newPlaceId = placeMap.get(Number(placeTag.place_id));
      if (!newPlaceId) continue;
      db.prepare('INSERT OR IGNORE INTO place_tags (place_id, tag_id) VALUES (?, ?)').run(newPlaceId, placeTag.tag_id);
    }

    const budgetItems = db.prepare('SELECT * FROM budget_items WHERE trip_id = ? ORDER BY sort_order, id').all(sourceTripId) as SqlRow[];
    for (const item of budgetItems) {
      const oldId = Number(item.id);
      const newId = insertDynamic('budget_items', buildInsertRow('budget_items', item, { trip_id: newTripId }));
      budgetItemMap.set(oldId, newId);
    }

    if (tableExists('budget_item_members')) {
      const sourceBudgetMemberCounts = new Map<number, number>();
      const copiedBudgetMemberCounts = new Map<number, number>();
      const sourceBudgetMembers = db.prepare(`
        SELECT bim.budget_item_id
        FROM budget_item_members bim
        JOIN budget_items bi ON bi.id = bim.budget_item_id
        WHERE bi.trip_id = ?
      `).all(sourceTripId) as Array<{ budget_item_id: number }>;
      for (const member of sourceBudgetMembers) {
        sourceBudgetMemberCounts.set(member.budget_item_id, (sourceBudgetMemberCounts.get(member.budget_item_id) ?? 0) + 1);
      }

      const budgetMembers = db.prepare(`
        SELECT bim.*
        FROM budget_item_members bim
        JOIN budget_items bi ON bi.id = bim.budget_item_id
        WHERE bi.trip_id = ?
        ORDER BY bim.budget_item_id, bim.user_id
      `).all(sourceTripId) as SqlRow[];
      for (const member of budgetMembers) {
        const sourceBudgetItemId = Number(member.budget_item_id);
        const newBudgetItemId = budgetItemMap.get(sourceBudgetItemId);
        if (!newBudgetItemId) continue;
        copiedBudgetMemberCounts.set(sourceBudgetItemId, (copiedBudgetMemberCounts.get(sourceBudgetItemId) ?? 0) + 1);
        insertDynamic('budget_item_members', buildInsertRow('budget_item_members', member, { budget_item_id: newBudgetItemId }));
      }

      for (const [sourceBudgetItemId, newBudgetItemId] of budgetItemMap.entries()) {
        if (!sourceBudgetMemberCounts.has(sourceBudgetItemId)) continue;
        const copiedCount = copiedBudgetMemberCounts.get(sourceBudgetItemId) ?? null;
        db.prepare('UPDATE budget_items SET persons = ? WHERE id = ?').run(copiedCount, newBudgetItemId);
      }
    }

    if (tableExists('packing_bags')) {
      const bags = db.prepare('SELECT * FROM packing_bags WHERE trip_id = ? ORDER BY sort_order, id').all(sourceTripId) as SqlRow[];
      for (const bag of bags) {
        const oldId = Number(bag.id);
        const newId = insertDynamic('packing_bags', buildInsertRow('packing_bags', bag, { trip_id: newTripId }));
        bagMap.set(oldId, newId);
      }
    }

    const packingItems = db.prepare('SELECT * FROM packing_items WHERE trip_id = ? ORDER BY sort_order, id').all(sourceTripId) as SqlRow[];
    for (const item of packingItems) {
      const bagId = item.bag_id == null ? null : bagMap.get(Number(item.bag_id)) ?? null;
      const overrides: SqlRow = { trip_id: newTripId };
      if (getTableColumns('packing_items').includes('bag_id')) overrides.bag_id = bagId;
      insertDynamic('packing_items', buildInsertRow('packing_items', item, overrides));
    }

    if (tableExists('packing_category_assignees')) {
      const assignees = db.prepare('SELECT * FROM packing_category_assignees WHERE trip_id = ? ORDER BY category_name, user_id').all(sourceTripId) as SqlRow[];
      for (const assignee of assignees) {
        insertDynamic('packing_category_assignees', buildInsertRow('packing_category_assignees', assignee, { trip_id: newTripId }));
      }
    }

    const assignments = db.prepare(`
      SELECT da.*
      FROM day_assignments da
      JOIN days d ON d.id = da.day_id
      WHERE d.trip_id = ?
      ORDER BY da.day_id, da.order_index, da.id
    `).all(sourceTripId) as SqlRow[];
    for (const assignment of assignments) {
      const oldId = Number(assignment.id);
      const newDayId = dayMap.get(Number(assignment.day_id));
      const newPlaceId = placeMap.get(Number(assignment.place_id));
      if (!newDayId || !newPlaceId) continue;

      const budgetItemId = assignment.budget_item_id == null ? null : budgetItemMap.get(Number(assignment.budget_item_id)) ?? null;
      const overrides: SqlRow = { day_id: newDayId, place_id: newPlaceId };
      if (getTableColumns('day_assignments').includes('budget_item_id')) overrides.budget_item_id = budgetItemId;
      const newId = insertDynamic('day_assignments', buildInsertRow('day_assignments', assignment, overrides));
      assignmentMap.set(oldId, newId);
    }

    if (tableExists('assignment_participants')) {
      const participants = db.prepare(`
        SELECT ap.*
        FROM assignment_participants ap
        JOIN day_assignments da ON da.id = ap.assignment_id
        JOIN days d ON d.id = da.day_id
        WHERE d.trip_id = ?
        ORDER BY ap.assignment_id, ap.user_id
      `).all(sourceTripId) as SqlRow[];
      for (const participant of participants) {
        const newAssignmentId = assignmentMap.get(Number(participant.assignment_id));
        if (!newAssignmentId) continue;
        insertDynamic('assignment_participants', buildInsertRow('assignment_participants', participant, { assignment_id: newAssignmentId }));
      }
    }

    if (tableExists('day_accommodations')) {
      const accommodations = db.prepare('SELECT * FROM day_accommodations WHERE trip_id = ? ORDER BY id').all(sourceTripId) as SqlRow[];
      for (const accommodation of accommodations) {
        const oldId = Number(accommodation.id);
        const newPlaceId = placeMap.get(Number(accommodation.place_id));
        const newStartDayId = dayMap.get(Number(accommodation.start_day_id));
        const newEndDayId = dayMap.get(Number(accommodation.end_day_id));
        if (!newPlaceId || !newStartDayId || !newEndDayId) continue;

        const budgetItemId = accommodation.budget_item_id == null ? null : budgetItemMap.get(Number(accommodation.budget_item_id)) ?? null;
        const overrides: SqlRow = {
          trip_id: newTripId,
          place_id: newPlaceId,
          start_day_id: newStartDayId,
          end_day_id: newEndDayId,
        };
        if (getTableColumns('day_accommodations').includes('budget_item_id')) overrides.budget_item_id = budgetItemId;
        const newId = insertDynamic('day_accommodations', buildInsertRow('day_accommodations', accommodation, overrides));
        accommodationMap.set(oldId, newId);
      }
    }

    const dayNotes = db.prepare('SELECT * FROM day_notes WHERE trip_id = ? ORDER BY day_id, sort_order, id').all(sourceTripId) as SqlRow[];
    for (const note of dayNotes) {
      const newDayId = dayMap.get(Number(note.day_id));
      if (!newDayId) continue;
      insertDynamic('day_notes', buildInsertRow('day_notes', note, { trip_id: newTripId, day_id: newDayId }));
    }

    const reservations = db.prepare('SELECT * FROM reservations WHERE trip_id = ? ORDER BY id').all(sourceTripId) as SqlRow[];
    for (const reservation of reservations) {
      const oldId = Number(reservation.id);
      const overrides: SqlRow = { trip_id: newTripId };
      if (reservation.day_id != null) overrides.day_id = dayMap.get(Number(reservation.day_id)) ?? null;
      if (reservation.place_id != null) overrides.place_id = placeMap.get(Number(reservation.place_id)) ?? null;
      if (reservation.assignment_id != null) overrides.assignment_id = assignmentMap.get(Number(reservation.assignment_id)) ?? null;
      if (getTableColumns('reservations').includes('accommodation_id')) {
        overrides.accommodation_id = reservation.accommodation_id == null ? null : accommodationMap.get(Number(reservation.accommodation_id)) ?? null;
      }
      if (getTableColumns('reservations').includes('budget_item_id')) {
        overrides.budget_item_id = reservation.budget_item_id == null ? null : budgetItemMap.get(Number(reservation.budget_item_id)) ?? null;
      }
      const newId = insertDynamic('reservations', buildInsertRow('reservations', reservation, overrides));
      reservationMap.set(oldId, newId);
    }

    if (tableExists('collab_notes')) {
      const collabNotes = db.prepare('SELECT * FROM collab_notes WHERE trip_id = ? ORDER BY pinned DESC, updated_at DESC, id DESC').all(sourceTripId) as SqlRow[];
      for (const note of collabNotes) {
        const oldId = Number(note.id);
        const newId = insertDynamic('collab_notes', buildInsertRow('collab_notes', note, { trip_id: newTripId }));
        collabNoteMap.set(oldId, newId);
      }
    }

    if (tableExists('collab_polls')) {
      const polls = db.prepare('SELECT * FROM collab_polls WHERE trip_id = ? ORDER BY created_at DESC, id DESC').all(sourceTripId) as SqlRow[];
      for (const poll of polls) {
        const oldId = Number(poll.id);
        const newId = insertDynamic('collab_polls', buildInsertRow('collab_polls', poll, { trip_id: newTripId }));
        pollMap.set(oldId, newId);
      }

      if (tableExists('collab_poll_votes')) {
        const pollVotes = db.prepare(`
          SELECT cpv.*
          FROM collab_poll_votes cpv
          JOIN collab_polls cp ON cp.id = cpv.poll_id
          WHERE cp.trip_id = ?
          ORDER BY cpv.poll_id, cpv.user_id, cpv.option_index
        `).all(sourceTripId) as SqlRow[];
        for (const vote of pollVotes) {
          const newPollId = pollMap.get(Number(vote.poll_id));
          if (!newPollId) continue;
          insertDynamic('collab_poll_votes', buildInsertRow('collab_poll_votes', vote, { poll_id: newPollId }));
        }
      }
    }

    if (tableExists('collab_messages')) {
      const repliesToRestore: Array<{ messageId: number; replyTo: number }> = [];
      const messages = db.prepare('SELECT * FROM collab_messages WHERE trip_id = ? ORDER BY created_at ASC, id ASC').all(sourceTripId) as SqlRow[];
      for (const message of messages) {
        const oldId = Number(message.id);
        const replyTo = message.reply_to == null ? null : Number(message.reply_to);
        const newId = insertDynamic('collab_messages', buildInsertRow('collab_messages', message, { trip_id: newTripId, reply_to: null }));
        messageMap.set(oldId, newId);
        if (replyTo) repliesToRestore.push({ messageId: newId, replyTo });
      }

      for (const reply of repliesToRestore) {
        const newReplyToId = messageMap.get(reply.replyTo);
        if (!newReplyToId) continue;
        db.prepare('UPDATE collab_messages SET reply_to = ? WHERE id = ?').run(newReplyToId, reply.messageId);
      }

      if (tableExists('collab_message_reactions')) {
        const reactions = db.prepare(`
          SELECT cmr.*
          FROM collab_message_reactions cmr
          JOIN collab_messages cm ON cm.id = cmr.message_id
          WHERE cm.trip_id = ?
          ORDER BY cmr.message_id, cmr.user_id, cmr.emoji
        `).all(sourceTripId) as SqlRow[];
        for (const reaction of reactions) {
          const newMessageId = messageMap.get(Number(reaction.message_id));
          if (!newMessageId) continue;
          insertDynamic('collab_message_reactions', buildInsertRow('collab_message_reactions', reaction, { message_id: newMessageId }));
        }
      }
    }

    const tripFileColumns = getTableColumns('trip_files');
    const tripFilesWhere = tripFileColumns.includes('deleted_at') ? 'trip_id = ? AND deleted_at IS NULL' : 'trip_id = ?';
    const tripFiles = db.prepare(`SELECT * FROM trip_files WHERE ${tripFilesWhere} ORDER BY id`).all(sourceTripId) as SqlRow[];
    for (const file of tripFiles) {
      if (tripFileColumns.includes('note_id') && file.note_id != null && !collabNoteMap.has(Number(file.note_id))) continue;

      const oldId = Number(file.id);
      const overrides: SqlRow = {
        trip_id: newTripId,
        filename: cloneStoredAsset(String(file.filename), filesDir, 'files', createdFiles) ?? file.filename,
        deleted_at: null,
      };
      if (file.place_id != null) overrides.place_id = placeMap.get(Number(file.place_id)) ?? null;
      if (file.reservation_id != null) overrides.reservation_id = reservationMap.get(Number(file.reservation_id)) ?? null;
      if (tripFileColumns.includes('note_id')) {
        overrides.note_id = file.note_id == null ? null : collabNoteMap.get(Number(file.note_id)) ?? null;
      }
      const newId = insertDynamic('trip_files', buildInsertRow('trip_files', file, overrides));
      fileMap.set(oldId, newId);
    }

    if (tableExists('file_links')) {
      const fileLinks = db.prepare(`
        SELECT fl.*
        FROM file_links fl
        JOIN trip_files tf ON tf.id = fl.file_id
        WHERE tf.trip_id = ?
        ORDER BY fl.id
      `).all(sourceTripId) as SqlRow[];
      for (const link of fileLinks) {
        const newFileId = fileMap.get(Number(link.file_id));
        if (!newFileId) continue;
        const overrides: SqlRow = { file_id: newFileId };
        if (link.reservation_id != null) overrides.reservation_id = reservationMap.get(Number(link.reservation_id)) ?? null;
        if (link.assignment_id != null) overrides.assignment_id = assignmentMap.get(Number(link.assignment_id)) ?? null;
        if (link.place_id != null) overrides.place_id = placeMap.get(Number(link.place_id)) ?? null;
        insertDynamic('file_links', buildInsertRow('file_links', link, overrides));
      }
    }

    if (tableExists('trip_photos')) {
      const tripPhotos = db.prepare(`
        SELECT tp.*
        FROM trip_photos tp
        LEFT JOIN trip_members tm ON tm.trip_id = tp.trip_id AND tm.user_id = tp.user_id
        WHERE tp.trip_id = ?
          AND (tp.user_id = ? OR tp.shared = 1)
          AND (tp.user_id = ? OR tm.user_id IS NOT NULL)
        ORDER BY tp.id
      `).all(sourceTripId, sourceTrip.user_id, sourceTrip.user_id) as SqlRow[];
      for (const tripPhoto of tripPhotos) {
        insertDynamic('trip_photos', buildInsertRow('trip_photos', tripPhoto, { trip_id: newTripId }));
      }
    }

    if (tableExists('photos')) {
      const legacyPhotos = db.prepare('SELECT * FROM photos WHERE trip_id = ? ORDER BY id').all(sourceTripId) as SqlRow[];
      for (const photo of legacyPhotos) {
        const overrides: SqlRow = {
          trip_id: newTripId,
          filename: cloneStoredAsset(String(photo.filename), legacyPhotosDir, 'photos', createdFiles) ?? photo.filename,
        };
        if (photo.day_id != null) overrides.day_id = dayMap.get(Number(photo.day_id)) ?? null;
        if (photo.place_id != null) overrides.place_id = placeMap.get(Number(photo.place_id)) ?? null;
        insertDynamic('photos', buildInsertRow('photos', photo, overrides));
      }
    }

    db.exec('COMMIT');

    const duplicatedTrip = db.prepare(`${TRIP_SELECT} WHERE t.id = :tripId`).get({ userId, tripId: newTripId }) as SqlRow | undefined;
    if (!duplicatedTrip) throw new Error('Failed to load duplicated trip');
    return duplicatedTrip;
  } catch (error) {
    db.exec('ROLLBACK');
    cleanupCreatedFiles(createdFiles);
    throw error;
  }
}

function generateDays(tripId: number | bigint | string, startDate: string | null, endDate: string | null) {
  const existing = db.prepare('SELECT id, day_number, date FROM days WHERE trip_id = ?').all(tripId) as { id: number; day_number: number; date: string | null }[];

  if (!startDate || !endDate) {
    const datelessExisting = existing.filter(d => !d.date).sort((a, b) => a.day_number - b.day_number);
    const withDates = existing.filter(d => d.date);
    if (withDates.length > 0) {
      db.prepare(`DELETE FROM days WHERE trip_id = ? AND date IS NOT NULL`).run(tripId);
    }
    const needed = 7 - datelessExisting.length;
    if (needed > 0) {
      const insert = db.prepare('INSERT INTO days (trip_id, day_number, date) VALUES (?, ?, NULL)');
      for (let i = 0; i < needed; i++) insert.run(tripId, datelessExisting.length + i + 1);
    } else if (needed < 0) {
      const toRemove = datelessExisting.slice(7);
      const del = db.prepare('DELETE FROM days WHERE id = ?');
      for (const d of toRemove) del.run(d.id);
    }
    const remaining = db.prepare('SELECT id FROM days WHERE trip_id = ? ORDER BY day_number').all(tripId) as { id: number }[];
    const tmpUpd = db.prepare('UPDATE days SET day_number = ? WHERE id = ?');
    remaining.forEach((d, i) => tmpUpd.run(-(i + 1), d.id));
    remaining.forEach((d, i) => tmpUpd.run(i + 1, d.id));
    return;
  }

  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const startMs = Date.UTC(sy, sm - 1, sd);
  const endMs = Date.UTC(ey, em - 1, ed);
  const numDays = Math.min(Math.floor((endMs - startMs) / MS_PER_DAY) + 1, MAX_TRIP_DAYS);

  const targetDates: string[] = [];
  for (let i = 0; i < numDays; i++) {
    const d = new Date(startMs + i * MS_PER_DAY);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    targetDates.push(`${yyyy}-${mm}-${dd}`);
  }

  const existingByDate = new Map<string, { id: number; day_number: number; date: string | null }>();
  for (const d of existing) {
    if (d.date) existingByDate.set(d.date, d);
  }

  const targetDateSet = new Set(targetDates);

  const toDelete = existing.filter(d => d.date && !targetDateSet.has(d.date));
  const datelessToDelete = existing.filter(d => !d.date);
  const del = db.prepare('DELETE FROM days WHERE id = ?');
  for (const d of [...toDelete, ...datelessToDelete]) del.run(d.id);

  const setTemp = db.prepare('UPDATE days SET day_number = ? WHERE id = ?');
  const kept = existing.filter(d => d.date && targetDateSet.has(d.date));
  for (let i = 0; i < kept.length; i++) setTemp.run(-(i + 1), kept[i].id);

  const insert = db.prepare('INSERT INTO days (trip_id, day_number, date) VALUES (?, ?, ?)');
  const update = db.prepare('UPDATE days SET day_number = ? WHERE id = ?');

  for (let i = 0; i < targetDates.length; i++) {
    const date = targetDates[i];
    const ex = existingByDate.get(date);
    if (ex) {
      update.run(i + 1, ex.id);
    } else {
      insert.run(tripId, i + 1, date);
    }
  }
}

router.get('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const archived = req.query.archived === '1' ? 1 : 0;
  const userId = authReq.user.id;
  const trips = db.prepare(`
    ${TRIP_SELECT}
    LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = :userId
    WHERE (t.user_id = :userId OR m.user_id IS NOT NULL) AND t.is_archived = :archived
    ORDER BY t.created_at DESC
  `).all({ userId, archived });
  res.json({ trips });
});

router.post('/', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { title, description, start_date, end_date, currency } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  if (start_date && end_date && new Date(end_date) < new Date(start_date))
    return res.status(400).json({ error: 'End date must be after start date' });

  const result = db.prepare(`
    INSERT INTO trips (user_id, title, description, start_date, end_date, currency)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(authReq.user.id, title, description || null, start_date || null, end_date || null, currency || 'EUR');

  const tripId = result.lastInsertRowid;
  generateDays(tripId, start_date, end_date);
  const trip = db.prepare(`${TRIP_SELECT} WHERE t.id = :tripId`).get({ userId: authReq.user.id, tripId });
  res.status(201).json({ trip });
});

router.post('/:id/duplicate', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const access = canAccessTrip(req.params.id, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!isOwner(req.params.id, authReq.user.id))
    return res.status(403).json({ error: 'Only the owner can duplicate the trip' });

  try {
    const title = typeof req.body?.title === 'string' ? req.body.title : undefined;
    const trip = duplicateTrip(req.params.id, authReq.user.id, title);
    res.status(201).json({ trip });
  } catch (error) {
    console.error('Failed to duplicate trip:', error);
    res.status(500).json({ error: 'Failed to duplicate trip' });
  }
});

router.get('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const userId = authReq.user.id;
  const trip = db.prepare(`
    ${TRIP_SELECT}
    LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = :userId
    WHERE t.id = :tripId AND (t.user_id = :userId OR m.user_id IS NOT NULL)
  `).get({ userId, tripId: req.params.id });
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  res.json({ trip });
});

router.put('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const access = canAccessTrip(req.params.id, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });

  const ownerOnly = req.body.is_archived !== undefined || req.body.cover_image !== undefined;
  if (ownerOnly && !isOwner(req.params.id, authReq.user.id))
    return res.status(403).json({ error: 'Only the owner can change this setting' });

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id) as Trip | undefined;
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  const { title, description, start_date, end_date, currency, is_archived, cover_image } = req.body;

  if (start_date && end_date && new Date(end_date) < new Date(start_date))
    return res.status(400).json({ error: 'End date must be after start date' });

  const newTitle = title || trip.title;
  const newDesc = description !== undefined ? description : trip.description;
  const newStart = start_date !== undefined ? start_date : trip.start_date;
  const newEnd = end_date !== undefined ? end_date : trip.end_date;
  const newCurrency = currency || trip.currency;
  const newArchived = is_archived !== undefined ? (is_archived ? 1 : 0) : trip.is_archived;
  let newCover = trip.cover_image;
  if (cover_image !== undefined) {
    const normalizedCover = normalizeCoverImageValue(cover_image);
    if (!normalizedCover.valid) return res.status(400).json({ error: 'Invalid cover image reference' });
    newCover = normalizedCover.value;
  }

  db.prepare(`
    UPDATE trips SET title=?, description=?, start_date=?, end_date=?,
      currency=?, is_archived=?, cover_image=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(newTitle, newDesc, newStart || null, newEnd || null, newCurrency, newArchived, newCover, req.params.id);

  if (newStart !== trip.start_date || newEnd !== trip.end_date)
    generateDays(req.params.id, newStart, newEnd);

  const updatedTrip = db.prepare(`${TRIP_SELECT} WHERE t.id = :tripId`).get({ userId: authReq.user.id, tripId: req.params.id });
  res.json({ trip: updatedTrip });
  broadcast(req.params.id, 'trip:updated', { trip: updatedTrip }, req.headers['x-socket-id'] as string);
});

router.post('/:id/cover', authenticate, demoUploadBlock, uploadCover.single('cover'), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!isOwner(req.params.id, authReq.user.id))
    return res.status(403).json({ error: 'Only the owner can change the cover image' });

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id) as Trip | undefined;
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

  if (trip.cover_image) {
    const oldPath = path.join(__dirname, '../../', trip.cover_image.replace(/^\//, ''));
    const resolvedPath = path.resolve(oldPath);
    const uploadsDir = path.resolve(__dirname, '../../uploads');
    if (resolvedPath.startsWith(uploadsDir) && fs.existsSync(resolvedPath)) {
      fs.unlinkSync(resolvedPath);
    }
  }

  const coverUrl = `/uploads/covers/${req.file.filename}`;
  db.prepare('UPDATE trips SET cover_image=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(coverUrl, req.params.id);
  res.json({ cover_image: coverUrl });
});

router.post('/:id/shift-dates', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const access = canAccessTrip(req.params.id, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });

  const { shift_days } = req.body;
  if (typeof shift_days !== 'number' || !Number.isFinite(shift_days) || shift_days === 0) {
    return res.status(400).json({ error: 'shift_days must be a non-zero number' });
  }

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id) as Trip | undefined;
  if (!trip) return res.status(404).json({ error: 'Trip not found' });

  // Calculate new trip dates
  let newStart = trip.start_date;
  let newEnd = trip.end_date;

  if (trip.start_date) {
    const d = new Date(trip.start_date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + shift_days);
    newStart = d.toISOString().split('T')[0];
  }
  if (trip.end_date) {
    const d = new Date(trip.end_date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + shift_days);
    newEnd = d.toISOString().split('T')[0];
  }

  db.exec('BEGIN');
  try {
    // Update trip dates
    db.prepare('UPDATE trips SET start_date = ?, end_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(newStart, newEnd, req.params.id);

    // Shift all day dates
    const days = db.prepare('SELECT id, date FROM days WHERE trip_id = ? AND date IS NOT NULL').all(req.params.id) as { id: number; date: string }[];
    const updateDay = db.prepare('UPDATE days SET date = ? WHERE id = ?');
    for (const day of days) {
      const d = new Date(day.date + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + shift_days);
      updateDay.run(d.toISOString().split('T')[0], day.id);
    }

    // Shift reservation dates
    const reservations = db.prepare('SELECT id, reservation_time, reservation_end_time FROM reservations WHERE trip_id = ?').all(req.params.id) as { id: number; reservation_time: string | null; reservation_end_time: string | null }[];
    const updateRes = db.prepare('UPDATE reservations SET reservation_time = ?, reservation_end_time = ? WHERE id = ?');
    for (const r of reservations) {
      let newResTime = r.reservation_time;
      let newResEndTime = r.reservation_end_time;
      if (r.reservation_time && r.reservation_time.includes('T')) {
        const d = new Date(r.reservation_time);
        d.setUTCDate(d.getUTCDate() + shift_days);
        newResTime = d.toISOString();
      }
      if (r.reservation_end_time && r.reservation_end_time.includes('T')) {
        const d = new Date(r.reservation_end_time);
        d.setUTCDate(d.getUTCDate() + shift_days);
        newResEndTime = d.toISOString();
      }
      if (newResTime !== r.reservation_time || newResEndTime !== r.reservation_end_time) {
        updateRes.run(newResTime, newResEndTime, r.id);
      }
    }

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: 'Failed to shift dates' });
  }

  const updatedTrip = db.prepare(`${TRIP_SELECT} WHERE t.id = :tripId`).get({ userId: authReq.user.id, tripId: req.params.id });
  const updatedDays = db.prepare('SELECT * FROM days WHERE trip_id = ? ORDER BY day_number').all(req.params.id);

  res.json({ trip: updatedTrip, days: updatedDays });
  broadcast(req.params.id, 'trip:updated', { trip: updatedTrip }, req.headers['x-socket-id'] as string);
});

router.delete('/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!isOwner(req.params.id, authReq.user.id))
    return res.status(403).json({ error: 'Only the owner can delete the trip' });
  const deletedTripId = Number(req.params.id);
  db.prepare('DELETE FROM trips WHERE id = ?').run(req.params.id);
  res.json({ success: true });
  broadcast(deletedTripId, 'trip:deleted', { id: deletedTripId }, req.headers['x-socket-id'] as string);
});

router.get('/:id/members', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!canAccessTrip(req.params.id, authReq.user.id))
    return res.status(404).json({ error: 'Trip not found' });

  const trip = db.prepare('SELECT user_id FROM trips WHERE id = ?').get(req.params.id) as { user_id: number };
  const members = db.prepare(`
    SELECT u.id, u.username, u.email, u.avatar,
      CASE WHEN u.id = ? THEN 'owner' ELSE 'member' END as role,
      m.added_at,
      ib.username as invited_by_username
    FROM trip_members m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN users ib ON ib.id = m.invited_by
    WHERE m.trip_id = ?
    ORDER BY m.added_at ASC
  `).all(trip.user_id, req.params.id) as { id: number; username: string; email: string; avatar: string | null; role: string; added_at: string; invited_by_username: string | null }[];

  const owner = db.prepare('SELECT id, username, email, avatar FROM users WHERE id = ?').get(trip.user_id) as Pick<User, 'id' | 'username' | 'email' | 'avatar'>;

  res.json({
    owner: { ...owner, role: 'owner', avatar_url: owner.avatar ? `/uploads/avatars/${owner.avatar}` : null },
    members: members.map(m => ({ ...m, avatar_url: m.avatar ? `/uploads/avatars/${m.avatar}` : null })),
    current_user_id: authReq.user.id,
  });
});

router.post('/:id/members', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!canAccessTrip(req.params.id, authReq.user.id))
    return res.status(404).json({ error: 'Trip not found' });

  const { identifier } = req.body;
  if (!identifier) return res.status(400).json({ error: 'Email or username required' });

  const target = db.prepare(
    'SELECT id, username, email, avatar FROM users WHERE email = ? OR username = ?'
  ).get(identifier.trim(), identifier.trim()) as Pick<User, 'id' | 'username' | 'email' | 'avatar'> | undefined;

  if (!target) return res.status(404).json({ error: 'User not found' });

  const trip = db.prepare('SELECT user_id FROM trips WHERE id = ?').get(req.params.id) as { user_id: number };
  if (target.id === trip.user_id)
    return res.status(400).json({ error: 'Trip owner is already a member' });

  const existing = db.prepare('SELECT id FROM trip_members WHERE trip_id = ? AND user_id = ?').get(req.params.id, target.id);
  if (existing) return res.status(400).json({ error: 'User already has access' });

  db.prepare('INSERT INTO trip_members (trip_id, user_id, invited_by) VALUES (?, ?, ?)').run(req.params.id, target.id, authReq.user.id);

  res.status(201).json({ member: { ...target, role: 'member', avatar_url: target.avatar ? `/uploads/avatars/${target.avatar}` : null } });
});

router.delete('/:id/members/:userId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  if (!canAccessTrip(req.params.id, authReq.user.id))
    return res.status(404).json({ error: 'Trip not found' });

  const targetId = parseInt(req.params.userId);
  const isSelf = targetId === authReq.user.id;
  if (!isSelf && !isOwner(req.params.id, authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  db.prepare('DELETE FROM trip_members WHERE trip_id = ? AND user_id = ?').run(req.params.id, targetId);
  res.json({ success: true });
});

export default router;
