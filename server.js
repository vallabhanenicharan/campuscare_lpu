/* CampusCare local server. Node.js 24+; no third-party packages required. */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const root = __dirname;
const dataDir = process.env.CAMPUSCARE_DATA_DIR || path.join(root, 'data');
const host = process.env.CAMPUSCARE_HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const cookieName = 'campuscare_session';
const maxBody = 22 * 1024 * 1024;
const maxImageBytes = 5 * 1024 * 1024;
const demoPassword = process.env.CAMPUSCARE_DEMO_PASSWORD || 'campus123';
// The local prototype has a demo invitation; hosted deployments must set their own.
const staffRegistrationCode = process.env.CAMPUSCARE_STAFF_REGISTRATION_CODE || (['127.0.0.1', 'localhost', '::1'].includes(host) ? 'campus-staff' : '');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'campuscare.sqlite');
const newDatabase = !fs.existsSync(dbPath);
const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, identity TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, profile TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS complaints (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), complaint_id TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS complaints_owner ON complaints(owner_id);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, created_at);`);

const icons = { Electrical:'⌁', Plumbing:'⌇', Carpentry:'▤', Cleaning:'✳', Other:'✦' };
const categories = Object.keys(icons);
const statuses = ['Submitted', 'Assigned', 'In progress', 'Resolved'];
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.webp':'image/webp' };
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const now = () => new Date().toISOString();
const safeProfile = row => ({ ...JSON.parse(row.profile), id:row.id, type:row.role, email:row.email });
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const send = (res, status, body, headers = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', ...headers });
  res.end(payload);
};
const fail = (res, status, message) => send(res, status, { error:message });

function seedUser(id, identity, email, role, profile) {
  if (db.prepare('SELECT id FROM users WHERE id = ?').get(id)) return;
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(demoPassword, salt, 64).toString('hex');
  db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, identity.toLowerCase(), email.toLowerCase(), role, salt, hash, JSON.stringify(profile));
}
seedUser('aarav','SAMPLE2024','aarav.7f31@demo.lpu','student',{name:'Aarav Sharma',initials:'AS',hostel:'BH-2',room:'Room 304',studentId:'SAMPLE2024',role:'Student · BH-2'});
seedUser('priya','SAMPLE2025','priya.4a82@demo.lpu','student',{name:'Priya Verma',initials:'PV',hostel:'GH-1',room:'Room 108',studentId:'SAMPLE2025',role:'Student · GH-1'});
seedUser('warden','WARDEN001','warden@demo.lpu','staff',{name:'Hostel Warden',initials:'HW',staffId:'WARDEN001',department:'Residential services',role:'Hostel Warden',jobType:'warden'});
seedUser('staff-rk','STAFF004','rk.electrical.91@demo.lpu','staff',{name:'R. Kumar',initials:'RK',staffId:'STAFF004',department:'Electrical',role:'Electrician · Electrical'});

function newComplaintId() {
  let id;
  do { id = `CC-${crypto.randomBytes(6).toString('hex').toUpperCase()}`; }
  while (db.prepare('SELECT id FROM complaints WHERE id=?').get(id));
  return id;
}

function timelineFor(status, previous, stamp) {
  const labels = ['Report submitted','Technician assigned','Repair in progress','Issue resolved'];
  const stageIndex = Math.max(0, statuses.indexOf(status));
  const currentIndex = status === 'Submitted' ? 1 : status === 'Assigned' ? 2 : stageIndex;
  return labels.map((title, index) => {
    const old = Array.isArray(previous) ? previous[index] : null;
    const complete = index < currentIndex || status === 'Resolved';
    const current = index === currentIndex && status !== 'Resolved';
    let detail;
    if (index === 0) detail = 'Your report was received by the maintenance desk.';
    else if (index === 1) detail = status === 'Submitted' ? 'We’re finding the right person for this repair.' : 'A technician has been assigned to the report.';
    else if (index === 2) detail = status === 'Assigned' ? 'The technician will share an estimated visit time.' : 'The maintenance team is working on the issue.';
    else detail = 'The issue has been marked as resolved.';
    const time = index <= stageIndex ? ((old && old.time) || stamp) : '';
    return { title, time, detail, ...(complete ? {complete:true} : {}), ...(current ? {current:true} : {}) };
  });
}

function seedDemoComplaints() {
  if (db.prepare('SELECT id FROM complaints LIMIT 1').get()) return;
  const examples = [
    { title:'Ceiling fan making noise', category:'Electrical', hostel:'BH-2', room:'Room 304', priority:'Standard', status:'In progress', hoursAgo:2, visitHours:1, assignee:'R. Kumar', description:'Fan has started making a rattling noise at medium speed.' },
    { title:'Washroom tap leaking', category:'Plumbing', hostel:'BH-2', room:'Floor 3, washroom', priority:'Urgent', status:'In progress', hoursAgo:5, visitHours:2, assignee:'S. Singh', description:'The tap near the third-floor washroom is leaking continuously.' },
    { title:'Study table drawer stuck', category:'Carpentry', hostel:'BH-2', room:'Room 304', priority:'Standard', status:'Submitted', hoursAgo:22, assignee:'Awaiting assignment', description:'The top drawer gets stuck and won’t open fully.' },
    { title:'Corridor light not working', category:'Electrical', hostel:'BH-2', room:'West wing, floor 2', priority:'Standard', status:'Resolved', hoursAgo:96, assignee:'R. Kumar', description:'The light outside the west-wing stairs had stopped working.' }
  ];
  const insert = db.prepare('INSERT INTO complaints VALUES (?,?,?,?,?)');
  for (const example of examples) {
    const createdAt = new Date(Date.now() - example.hoursAgo * 60 * 60 * 1000).toISOString();
    const updatedAt = new Date(Date.now() - Math.min(example.hoursAgo, 1) * 60 * 60 * 1000).toISOString();
    const visitAt = example.visitHours ? new Date(Date.now() + example.visitHours * 60 * 60 * 1000).toISOString() : '';
    const item = {
      id:newComplaintId(), ...example, icon:icons[example.category], description:example.description,
      visitAt, visitTime:visitAt || (example.status === 'Resolved' ? 'Completed' : 'Awaiting dispatch'),
      updatedAt, createdAt, created:createdAt, updated:updatedAt, ownerAccount:'aarav',
      messages:[], timeline:timelineFor(example.status,null,createdAt)
    };
    delete item.hoursAgo;
    delete item.visitHours;
    insert.run(item.id,'aarav',createdAt,updatedAt,JSON.stringify(item));
  }
}
// Sample reports belong only in a newly created database; an empty existing
// database can be intentional and must not be repopulated on restart.
if (newDatabase) seedDemoComplaints();

function getSession(req) {
  const match = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + cookieName + '=([a-f0-9]{64})(?:;|$)'));
  if (!match) return null;
  const row = db.prepare('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?').get(hashToken(match[1]), Date.now());
  return row ? safeProfile(row) : null;
}
function cookie(token, maxAge) {
  const secure = process.env.CAMPUSCARE_SECURE_COOKIE === '1' ? '; Secure' : '';
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
const attempts = new Map();
function loginAllowed(req, identity) {
  const key = `${req.socket.remoteAddress}:${identity}`;
  const record = attempts.get(key) || { count:0, until:0 };
  if (record.until > Date.now()) return false;
  if (record.until && record.until <= Date.now()) attempts.delete(key);
  return true;
}
function loginFailed(req, identity) {
  const key = `${req.socket.remoteAddress}:${identity}`;
  const record = attempts.get(key) || { count:0, until:0 };
  record.count++;
  if (record.count >= 8) { record.count = 0; record.until = Date.now() + 60 * 1000; }
  attempts.set(key, record);
}

async function readJson(req) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw { status:415, message:'Send JSON data.' };
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) throw { status:413, message:'Upload is too large.' };
    chunks.push(chunk);
  }
  try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error(); return body; }
  catch { throw { status:400, message:'Invalid JSON.' }; }
}

function parsePhotos(photos) {
  if (photos === undefined) return [];
  if (!Array.isArray(photos) || photos.length > 3) throw { status:400, message:'Choose at most three photos.' };
  return photos.map(photo => {
    if (!photo || typeof photo.dataUrl !== 'string') throw { status:400, message:'Invalid photo.' };
    const found = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(photo.dataUrl);
    if (!found) throw { status:400, message:'Photos must be JPEG, PNG or WebP.' };
    const bytes = Buffer.from(found[2], 'base64');
    if (!bytes.length || bytes.length > maxImageBytes) throw { status:400, message:'Each photo must be at most 5 MB.' };
    const valid = found[1] === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : found[1] === 'image/png' ? bytes.length >= 8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : bytes.length >= 12 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
    if (!valid) throw { status:400, message:'The photo contents do not match its image type.' };
    return { name:text(photo.name,100) || 'Photo', dataUrl:`data:${found[1]};base64,${bytes.toString('base64')}` };
  });
}
function saveComplaint(item) {
  db.prepare('UPDATE complaints SET updated_at=?, data=? WHERE id=?').run(item.updatedAt, JSON.stringify(item), item.id);
}
function findComplaint(id, user) {
  const row = db.prepare('SELECT * FROM complaints WHERE id=?').get(id);
  if (!row || (user.type !== 'staff' && row.owner_id !== user.id) || (user.type === 'staff' && user.jobType !== 'warden' && JSON.parse(row.data).assignee !== user.name)) return null;
  return JSON.parse(row.data);
}
function notify(ownerId, complaint, message) {
  db.prepare('INSERT INTO notifications VALUES (?,?,?,?,?,?,0)').run(crypto.randomUUID(),ownerId,complaint.id,complaint.title,message,now());
}

async function api(req, res, pathname) {
  if (req.method !== 'GET' && req.headers.origin) {
    const origin = new URL(req.headers.origin);
    if (origin.host !== req.headers.host || !['http:','https:'].includes(origin.protocol)) return fail(res,403,'Origin is not allowed.');
  }
  if (pathname === '/api/register' && req.method === 'POST') {
    const body = await readJson(req);
    const kind = text(body.kind,20), name = text(body.name,100), identity = text(body.identity,80).toLowerCase(), email = text(body.email,160).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    const hostel = text(body.hostel,30), room = text(body.room,40), department = text(body.department,60);
    if (!['student','warden','technician'].includes(kind) || name.length < 2 || !/^[a-z0-9][a-z0-9._-]{2,79}$/.test(identity) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(res,400,'Enter a valid name, ID and email address. IDs must be at least 3 letters or numbers.');
    if (password.length < 8 || password.length > 256) return fail(res,400,'Choose a password between 8 and 256 characters.');
    if (kind === 'student' && (!hostel || !room)) return fail(res,400,'Enter your hostel and room or area.');
    if (kind !== 'student') {
      const registrationAttempt = '__staff_registration__';
      if (!loginAllowed(req, registrationAttempt)) return fail(res,429,'Too many attempts. Try again shortly.');
      if (!staffRegistrationCode || typeof body.staffCode !== 'string' || body.staffCode !== staffRegistrationCode) { loginFailed(req, registrationAttempt); return fail(res,403,'A valid staff registration code is required. Contact the administrator.'); }
    }
    if (kind === 'technician' && !department) return fail(res,400,'Enter your maintenance department.');
    if (db.prepare('SELECT id FROM users WHERE identity IN (?,?) OR email IN (?,?)').get(identity,email,identity,email)) return fail(res,409,'That ID or email is already in use.');
    if (kind === 'technician' && db.prepare("SELECT profile FROM users WHERE role='staff'").all().some(row => { const profile=JSON.parse(row.profile); return profile.jobType !== 'warden' && profile.name.toLowerCase() === name.toLowerCase(); })) return fail(res,409,'A technician with that name already exists. Please use a distinct name.');
    const id=crypto.randomUUID(), salt=crypto.randomBytes(16).toString('hex'), hash=crypto.scryptSync(password,salt,64).toString('hex');
    const initials=name.split(/\s+/).map(part=>part[0]).slice(0,2).join('').toUpperCase();
    const role=kind === 'student' ? 'student' : 'staff';
    const profile=kind === 'student' ? {name,initials,studentId:identity,hostel,room,role:`Student · ${hostel}`} : {name,initials,staffId:identity,department:kind === 'warden' ? 'Residential services' : department,role:kind === 'warden' ? 'Hostel Warden' : `Technician · ${department}`,jobType:kind};
    db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run(id,identity,email,role,salt,hash,JSON.stringify(profile));
    return send(res,201,{ok:true});
  }
  if (pathname === '/api/login' && req.method === 'POST') {
    const body = await readJson(req);
    const identity = text(body.identity, 160).toLowerCase();
    if (!loginAllowed(req, identity)) return fail(res,429,'Too many attempts. Try again shortly.');
    const row = db.prepare('SELECT * FROM users WHERE identity=? OR email=?').get(identity,identity);
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length > 256) return fail(res,400,'Invalid credentials.');
    const actual = crypto.scryptSync(password, row ? row.salt : '00000000000000000000000000000000',64);
    const expected = row ? Buffer.from(row.password_hash,'hex') : Buffer.alloc(64);
    const jobType = row && row.role === 'staff' ? (JSON.parse(row.profile).jobType || 'technician') : null;
    if (!row || !crypto.timingSafeEqual(actual,expected) || (body.role && body.role !== row.role) || (body.jobType && body.jobType !== jobType)) { loginFailed(req,identity); return fail(res,401,'Incorrect ID, password or account type.'); }
    const token = crypto.randomBytes(32).toString('hex');
    const seconds = body.remember === true ? 30 * 24 * 60 * 60 : 8 * 60 * 60;
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hashToken(token),row.id,Date.now()+seconds*1000);
    return send(res,200,{user:safeProfile(row)},{'Set-Cookie':cookie(token,seconds)});
  }
  if (pathname === '/api/logout' && req.method === 'POST') {
    const match = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + cookieName + '=([a-f0-9]{64})(?:;|$)'));
    if (match) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(match[1]));
    return send(res,200,{ok:true},{'Set-Cookie':cookie('',0)});
  }
  const user = getSession(req);
  if (!user) return fail(res,401,'Sign in to continue.');
  if (pathname === '/api/session' && req.method === 'GET') return send(res,200,{user});
  if (pathname === '/api/technicians' && req.method === 'GET') {
    if (user.type !== 'staff' || user.jobType !== 'warden') return fail(res,403,'Only wardens can view the technician list.');
    const technicians=db.prepare("SELECT id,profile FROM users WHERE role='staff'").all().map(row=>({id:row.id,...JSON.parse(row.profile)})).filter(profile=>profile.jobType !== 'warden').map(({id,name,department})=>({id,name,department})).sort((a,b)=>a.name.localeCompare(b.name));
    return send(res,200,{technicians});
  }
  if (pathname === '/api/complaints' && req.method === 'GET') {
    const rows = user.type === 'staff' ? db.prepare('SELECT data FROM complaints ORDER BY updated_at DESC').all() : db.prepare('SELECT data FROM complaints WHERE owner_id=? ORDER BY updated_at DESC').all(user.id);
    return send(res,200,{complaints:rows.map(row=>JSON.parse(row.data)).filter(item => user.type !== 'staff' || user.jobType === 'warden' || item.assignee === user.name)});
  }
  if (pathname === '/api/complaints' && req.method === 'POST') {
    if (user.type !== 'student') return fail(res,403,'Only students can submit reports.');
    const body = await readJson(req);
    const title = text(body.title,70), category = text(body.category,30), room = text(body.room,40), hostel = text(body.hostel,30), priority = text(body.priority,20) || 'Standard';
    if (!title || !room || !hostel || !text(body.description,1000) || !categories.includes(category) || !['Standard','Urgent'].includes(priority)) return fail(res,400,'Enter a title, category, description, hostel, room and valid urgency.');
    const stamp = now(), id = newComplaintId();
    const item = {id,title,category,icon:icons[category],hostel,room,priority,description:text(body.description,1000),status:'Submitted',assignee:'Awaiting assignment',assigneePhone:'',visitAt:'',visitTime:'Awaiting dispatch',createdAt:stamp,updatedAt:stamp,created:stamp,updated:stamp,ownerAccount:user.id,photos:parsePhotos(body.photos),messages:[],timeline:timelineFor('Submitted',null,stamp)};
    db.prepare('INSERT INTO complaints VALUES (?,?,?,?,?)').run(id,user.id,stamp,stamp,JSON.stringify(item));
    return send(res,201,{complaint:item});
  }
  const route = /^\/api\/complaints\/([A-Za-z0-9-]+)(?:\/(messages|feedback|decision))?$/.exec(pathname);
  if (route) {
    // Read the request before loading the record so concurrent edits do not
    // operate on snapshots captured while another request is still uploading.
    const action = route[2];
    const readsBody = (!action && req.method === 'PATCH') || ((['messages','feedback','decision'].includes(action)) && req.method === 'POST');
    const body = readsBody ? await readJson(req) : null;
    const item = findComplaint(route[1],user);
    if (!item) return fail(res,404,'Report not found.');
    if (!action && req.method === 'DELETE') {
      if (user.type !== 'student') return fail(res,403,'Only students can delete their own reports.');
      if (item.status !== 'Submitted') return fail(res,409,'Only submitted reports can be deleted.');
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM complaints WHERE id=? AND owner_id=?').run(item.id,user.id);
        db.prepare('DELETE FROM notifications WHERE complaint_id=?').run(item.id);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return send(res,200,{ok:true});
    }
    if (!action && req.method === 'PATCH') {
      if (user.type !== 'staff') return fail(res,403,'Only staff can update reports.');
      const warden = user.jobType === 'warden';
      if (item.status === 'Closed') return fail(res,409,'This complaint is closed.');
      if (warden && body.status && ![item.status, 'Assigned'].includes(body.status)) return fail(res,403,'The technician updates repair progress.');
      if (!warden && (body.priority !== undefined || (body.assignee !== undefined && body.assignee !== item.assignee) || body.assigneePhone !== undefined || body.visitAt !== undefined)) return fail(res,403,'Only the warden can review or assign a complaint.');
      if (!warden && !['Assigned','In progress'].includes(item.status)) return fail(res,409,'This task is not available for a technician update.');
      let status = body.status === undefined ? item.status : text(body.status,30);
      const priority = body.priority === undefined ? item.priority : text(body.priority,20);
      if (!['Standard','Urgent'].includes(priority)) return fail(res,400,'Choose a valid priority.');
      const completionDetails = text(body.completionDetails,1000);
      const completionPhotos = body.completionPhotos === undefined ? [] : parsePhotos(body.completionPhotos);
      if (status === 'Resolved' && item.status !== 'Resolved' && !completionDetails) return fail(res,400,'Add completion details before resolving the complaint.');
      const assignee = body.assignee === undefined ? item.assignee : text(body.assignee,100);
      if (warden && assignee && assignee !== 'Awaiting assignment' && assignee !== item.assignee) {
        const technicians = db.prepare("SELECT profile FROM users WHERE role='staff'").all().map(row => JSON.parse(row.profile));
        if (!technicians.some(profile => profile.jobType !== 'warden' && profile.name === assignee)) return fail(res,400,'Choose an available technician account.');
      }
      let assigneePhone = assignee !== item.assignee ? '' : (item.assigneePhone || '');
      if (body.assigneePhone !== undefined) {
        if (typeof body.assigneePhone !== 'string') return fail(res,400,'Enter a valid technician phone number.');
        assigneePhone = body.assigneePhone.trim();
        const digitCount = assigneePhone.replace(/\D/g, '').length;
        if (assigneePhone && (assigneePhone.length > 30 || !/^\+?[0-9 ()-]+$/.test(assigneePhone) || digitCount < 7 || digitCount > 15)) return fail(res,400,'Enter a valid technician phone number with 7 to 15 digits.');
      }
      if (status === 'Submitted' && item.status === 'Submitted' && item.assignee === 'Awaiting assignment' && assignee && assignee !== 'Awaiting assignment') status = 'Assigned';
      if (!statuses.includes(status)) return fail(res,400,'Choose a valid status.');
      const oldIndex = statuses.indexOf(item.status), newIndex = statuses.indexOf(status);
      if (newIndex !== oldIndex && newIndex !== oldIndex+1) return fail(res,400,'Move a report forward one status at a time.');
      if (newIndex >= 1 && (!assignee || assignee === 'Awaiting assignment')) return fail(res,400,'Assign a technician before advancing the report.');
      if (assigneePhone && (!assignee || assignee === 'Awaiting assignment')) return fail(res,400,'Assign a technician before adding a phone number.');
      let visitAt = item.visitAt || '';
      if (body.visitAt !== undefined) {
        if (body.visitAt === '' || body.visitAt === null) visitAt = '';
        else { const date = new Date(body.visitAt); if (!Number.isFinite(date.getTime())) return fail(res,400,'Enter a valid visit time.'); visitAt = date.toISOString(); }
      }
      const stamp=now(), message=text(body.message,1000), changes=[];
      if (warden && !item.reviewedAt) { item.reviewedAt=stamp; item.reviewedBy=user.name; changes.push('The warden reviewed the complaint.'); }
      if (priority !== item.priority) changes.push('Priority changed to ' + priority + '.');
      item.priority=priority;
      if (status === 'Resolved' && item.status !== 'Resolved') item.resolution={details:completionDetails,photos:completionPhotos,completedAt:stamp,completedBy:user.name};
      if (status !== item.status) changes.push(`Status changed to ${status}.`);
      if (assignee !== item.assignee) changes.push(`Technician assigned: ${assignee}.`);
      if (assigneePhone !== (item.assigneePhone || '')) changes.push('Technician contact details updated.');
      if (visitAt !== (item.visitAt || '')) changes.push(visitAt ? `A visit has been scheduled.` : 'The visit time was cleared.');
      item.status=status; item.assignee=assignee || 'Awaiting assignment'; item.assigneePhone=assigneePhone; item.visitAt=visitAt; item.visitTime=visitAt || (status === 'Resolved' ? 'Completed' : status === 'Submitted' ? 'Awaiting dispatch' : 'Visit time being confirmed');
      item.updatedAt=stamp; item.updated=stamp; item.timeline=timelineFor(status,item.timeline,stamp);
      if (message) { item.messages.push({id:crypto.randomUUID(),sender:user.name,senderType:'staff',text:message,createdAt:Date.now(),time:stamp}); changes.push(message); }
      db.exec('BEGIN'); try { saveComplaint(item); if(changes.length) notify(item.ownerAccount,item,changes.join(' ')); db.exec('COMMIT'); } catch(e) {db.exec('ROLLBACK');throw e;}
      return send(res,200,{complaint:item});
    }
    if (action === 'decision' && req.method === 'POST') {
      if (user.type !== 'student' || item.ownerAccount !== user.id) return fail(res,403,'Only the reporting student can make this decision.');
      if (item.status !== 'Resolved') return fail(res,409,'A decision is available after the technician resolves the complaint.');
      const decision = text(body.decision,20), reason = text(body.reason,500);
      if (!['close','reopen','escalate'].includes(decision)) return fail(res,400,'Choose close, reopen or escalate.');
      if (decision !== 'close' && !reason) return fail(res,400,'Please explain what still needs attention.');
      const stamp=now();
      item.messages = Array.isArray(item.messages) ? item.messages : [];
      item.messages.push({id:crypto.randomUUID(),sender:user.name,senderType:'student',text:decision === 'close' ? 'Confirmed that the issue is fixed and closed the complaint.' : (decision === 'escalate' ? 'Escalated: ' : 'Reopened: ') + reason,createdAt:Date.now(),time:stamp});
      item.status=decision === 'close' ? 'Closed' : 'Submitted';
      item.closedAt=decision === 'close' ? stamp : '';
      if (decision !== 'close') { item.previousResolutions = [...(item.previousResolutions || []), ...(item.resolution ? [item.resolution] : [])]; item.resolution=null; item.reviewedAt=''; item.assignee='Awaiting assignment'; item.assigneePhone=''; item.visitAt=''; item.visitTime='Awaiting warden review'; item.escalated=decision === 'escalate'; item.reopenReason=reason; item.timeline=timelineFor('Submitted',null,stamp); }
      item.updatedAt=stamp; item.updated=stamp; saveComplaint(item);
      return send(res,200,{complaint:item});
    }
    if (action === 'messages' && req.method === 'POST') {
      if (user.type !== 'staff') return fail(res,403,'Only staff can send maintenance updates.');
      const message=text(body.text,1000); if(!message) return fail(res,400,'Enter a message.');
      const stamp=now(); item.messages.push({id:crypto.randomUUID(),sender:user.name,senderType:'staff',text:message,createdAt:Date.now(),time:stamp}); item.updatedAt=stamp;item.updated=stamp;
      db.exec('BEGIN');try {saveComplaint(item);notify(item.ownerAccount,item,message);db.exec('COMMIT');} catch(e){db.exec('ROLLBACK');throw e;}
      return send(res,200,{complaint:item});
    }
    if (action === 'feedback' && req.method === 'POST') {
      if (user.type !== 'student' || item.ownerAccount !== user.id) return fail(res,403,'Only the reporting student can leave feedback.');
      if(!['Resolved','Closed'].includes(item.status)) return fail(res,400,'Feedback is available after resolution.');
      const rating=Number(body.rating); if(!Number.isInteger(rating)||rating<1||rating>5) return fail(res,400,'Choose a rating from 1 to 5.');
      item.rating=rating;item.feedback=text(body.feedback,300);item.updatedAt=now();item.updated=item.updatedAt;saveComplaint(item);return send(res,200,{complaint:item});
    }
    return fail(res,405,'Method not allowed.');
  }
  if (pathname === '/api/notifications' && req.method === 'GET') {
    const rows=db.prepare('SELECT id,complaint_id,title,message,created_at,is_read FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(user.id);
    return send(res,200,{notifications:rows.map(r=>({id:r.id,complaintId:r.complaint_id,title:r.title,message:r.message,createdAt:r.created_at,read:!!r.is_read}))});
  }
  if (pathname === '/api/notifications/read' && req.method === 'POST') {
    const body=await readJson(req);
    if (body.ids === undefined) db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(user.id);
    else if (Array.isArray(body.ids) && body.ids.length<=100 && body.ids.every(id=>typeof id==='string')) {const update=db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=? AND id=?');for(const id of body.ids) update.run(user.id,id);}
    else return fail(res,400,'Invalid notification IDs.');
    return send(res,200,{ok:true});
  }
  return fail(res,404,'Endpoint not found.');
}

function staticFile(req,res,pathname) {
  if (!['GET','HEAD'].includes(req.method)) return fail(res,405,'Method not allowed.');
  let filename;
  try {filename=decodeURIComponent(pathname === '/' ? '/index.html' : pathname);} catch {return fail(res,400,'Invalid path.');}
  if (!/^\/[A-Za-z0-9._ -]+$/.test(filename) || filename.toLowerCase() === '/server.js' || filename.startsWith('/.')) return fail(res,404,'Not found.');
  const ext=path.extname(filename).toLowerCase(); if(!mime[ext]) return fail(res,404,'Not found.');
  const file=path.join(root,filename.slice(1));
  fs.readFile(file,(err,bytes)=>{
    if(err) return fail(res,404,'Not found.');
    res.writeHead(200,{'Content-Type':mime[ext],'X-Content-Type-Options':'nosniff','Cache-Control':'no-cache','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"});
    res.end(req.method === 'HEAD' ? undefined : bytes);
  });
}
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.startsWith('/api/')) await api(req,res,url.pathname); else staticFile(req,res,url.pathname);
  } catch(e) { if(!res.headersSent) fail(res,e.status || 500,e.status ? e.message : 'The server could not complete the request.'); else res.end(); if(!e.status) console.error(e); }
});
server.listen(port,host,()=>console.log(`CampusCare running at http://${host}:${port} (local demo accounts; data in ${dataDir})`));
