'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const root = path.resolve(__dirname, '..');
let server, base, testData;

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

before(async () => {
  testData = fs.mkdtempSync(path.join(os.tmpdir(), 'campuscare-test-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, CAMPUSCARE_HOST: '127.0.0.1', CAMPUSCARE_DATA_DIR: testData, CAMPUSCARE_STAFF_REGISTRATION_CODE: 'test-invite', CAMPUSCARE_DEMO_PASSWORD: 'campus123', CAMPUSCARE_SECURE_COOKIE: '0', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test server did not start.')), 10000);
    server.stdout.on('data', data => { if (String(data).includes('CampusCare running')) { clearTimeout(timer); resolve(); } });
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Test server exited: ${code}`)); });
  });
});

after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill();
    await exited;
  }
  if (testData && path.dirname(testData) === os.tmpdir() && path.basename(testData).startsWith('campuscare-test-')) fs.rmSync(testData, { recursive: true, force: true });
});

async function request(route, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(base + route, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json();
  return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

async function login(identity, password, role, jobType) {
  const result = await request('/api/login', { method: 'POST', body: { identity, password, role, jobType } });
  assert.equal(result.status, 200);
  return result;
}

test('all local HTML assets are included in the container', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const ignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');
  const references = [...html.matchAll(/(?:src|href)="([^"#?]+)"/g)].map(match => match[1]).filter(value => !/^(?:https?:|mailto:|tel:)/.test(value));
  for (const asset of new Set(references)) {
    assert.ok(fs.existsSync(path.join(root, asset)), `${asset} is missing`);
    assert.ok(dockerfile.includes(asset), `${asset} is missing from Dockerfile`);
    assert.ok(ignore.split(/\r?\n/).includes(`!${asset}`), `${asset} is excluded from the build context`);
  }
});

test('registration, role access, assignment and resolution lifecycle', async () => {
  const student = { kind: 'student', name: 'Test Student', identity: 'student123', email: 'student@example.test', password: 'password123', hostel: 'BH-1', room: '101' };
  const technician = { kind: 'technician', name: 'Test Technician', identity: 'tech123', email: 'tech@example.test', password: 'password123', department: 'Plumbing', staffCode: 'test-invite' };
  const warden = { kind: 'warden', name: 'Test Warden', identity: 'warden123', email: 'warden@example.test', password: 'password123', staffCode: 'test-invite' };
  assert.equal((await request('/api/register', { method: 'POST', body: { ...technician, staffCode: 'incorrect' } })).status, 403);
  for (const body of [student, technician, warden]) assert.equal((await request('/api/register', { method: 'POST', body })).status, 201);
  assert.equal((await request('/api/register', { method: 'POST', body: student })).status, 409);
  const studentSession = (await login(student.identity, student.password, 'student')).cookie;
  const technicianSession = (await login(technician.identity, technician.password, 'staff', 'technician')).cookie;
  const wardenSession = (await login(warden.identity, warden.password, 'staff', 'warden')).cookie;
  const otherStudent = (await login('SAMPLE2025', 'campus123', 'student')).cookie;
  assert.equal((await request('/api/login', { method: 'POST', body: { identity: technician.identity, password: technician.password, role: 'staff', jobType: 'warden' } })).status, 401);
  assert.equal((await request('/api/technicians', { cookie: studentSession })).status, 403);
  assert.ok((await request('/api/technicians', { cookie: wardenSession })).data.technicians.some(item => item.name === technician.name));
  let response = await request('/api/complaints', { method: 'POST', cookie: studentSession, body: { title: 'Leaking tap', category: 'Plumbing', hostel: student.hostel, room: student.room, priority: 'Standard', description: 'The tap is leaking.' } });
  assert.equal(response.status, 201);
  const route = `/api/complaints/${response.data.complaint.id}`;
  assert.equal((await request(route, { method: 'PATCH', cookie: technicianSession, body: { status: 'In progress' } })).status, 404);
  assert.equal((await request(route, { method: 'PATCH', cookie: wardenSession, body: { status: 'Assigned', assignee: technician.name, priority: 'Urgent' } })).status, 200);
  response = await request('/api/complaints', { cookie: technicianSession });
  assert.ok(response.data.complaints.some(item => route.endsWith(item.id)));
  assert.equal((await request(route, { method: 'PATCH', cookie: wardenSession, body: { status: 'In progress' } })).status, 403);
  assert.equal((await request(route, { method: 'PATCH', cookie: technicianSession, body: { status: 'In progress' } })).status, 200);
  assert.equal((await request(route, { method: 'PATCH', cookie: technicianSession, body: { status: 'Resolved' } })).status, 400);
  const photo = { name: 'repair.png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=' };
  response = await request(route, { method: 'PATCH', cookie: technicianSession, body: { status: 'Resolved', completionDetails: 'Replaced the tap.', completionPhotos: [photo] } });
  assert.equal(response.status, 200);
  assert.equal(response.data.complaint.resolution.photos[0].name, photo.name);
  assert.equal((await request(`${route}/decision`, { method: 'POST', cookie: otherStudent, body: { decision: 'close' } })).status, 404);
  assert.equal((await request(`${route}/decision`, { method: 'POST', cookie: studentSession, body: { decision: 'reopen' } })).status, 400);
  response = await request(`${route}/decision`, { method: 'POST', cookie: studentSession, body: { decision: 'escalate', reason: 'Still leaking.' } });
  assert.equal(response.data.complaint.status, 'Submitted');
  assert.equal(response.data.complaint.escalated, true);
  assert.equal(response.data.complaint.previousResolutions.length, 1);
  assert.equal((await request(route, { method: 'PATCH', cookie: wardenSession, body: { status: 'Assigned', assignee: technician.name } })).status, 200);
  assert.equal((await request(route, { method: 'PATCH', cookie: technicianSession, body: { status: 'In progress' } })).status, 200);
  assert.equal((await request(route, { method: 'PATCH', cookie: technicianSession, body: { status: 'Resolved', completionDetails: 'Fixed the pipe.' } })).status, 200);
  response = await request(`${route}/decision`, { method: 'POST', cookie: studentSession, body: { decision: 'close' } });
  assert.equal(response.data.complaint.status, 'Closed');
  assert.equal((await request(`${route}/feedback`, { method: 'POST', cookie: studentSession, body: { rating: 5, feedback: 'Thank you.' } })).status, 200);
  assert.ok((await request('/api/notifications', { cookie: studentSession })).data.notifications.length > 0);
});

test('staff registration rejects repeated invalid codes', async () => {
  const body = { kind: 'warden', name: 'Another Warden', identity: 'anotherwarden', email: 'another@example.test', password: 'password123', staffCode: 'wrong' };
  for (let i = 0; i < 7; i++) assert.equal((await request('/api/register', { method: 'POST', body })).status, 403);
  assert.equal((await request('/api/register', { method: 'POST', body })).status, 429);
});
