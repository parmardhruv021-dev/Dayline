import './env.mjs';
import { scrypt as scryptCallback, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { db, id, now, transaction, audit } from './db.mjs';
import { validTimeZone } from './time.mjs';

const scrypt = promisify(scryptCallback);
const [emailRaw, fullNameRaw, organizationRaw, password] = process.argv.slice(2);
if (!emailRaw || !fullNameRaw || !organizationRaw || !password) {
  console.error('Usage: node src/provision.mjs <admin-email> <full-name> <organization-name> <password>');
  process.exit(2);
}
const email = emailRaw.trim().toLowerCase(); const fullName = fullNameRaw.trim(); const organization = organizationRaw.trim();
const timeZone = process.env.ORG_TIME_ZONE || 'America/Los_Angeles';
if (!/^\S+@\S+\.\S+$/.test(email) || fullName.length < 2 || organization.length < 2 || password.length < 14) throw new Error('Provide a valid email, names of at least two characters, and a password of at least 14 characters.');
if (!validTimeZone(timeZone)) throw new Error(`ORG_TIME_ZONE is not a valid IANA time zone: ${timeZone}`);
const salt = randomBytes(16).toString('hex'); const passwordHash = `${salt}:${(await scrypt(password,salt,64)).toString('hex')}`;
transaction(() => {
  const existingUser = db.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(email);
  if (existingUser) throw new Error('An account with this email already exists.');
  if (db.prepare('SELECT 1 FROM memberships WHERE role=\'admin\' AND organization_id IN (SELECT id FROM organizations WHERE name=?)').get(organization)) throw new Error('This organization already has an administrator.');
  const orgId=id(), userId=id(), membershipId=id(), at=now();
  db.prepare('INSERT INTO organizations(id,name,time_zone,created_at) VALUES (?,?,?,?)').run(orgId,organization,timeZone,at);
  db.prepare('INSERT INTO users(id,email,full_name,password_hash,created_at) VALUES (?,?,?,?,?)').run(userId,email,fullName,passwordHash,at);
  db.prepare('INSERT INTO memberships(id,organization_id,user_id,role,created_at) VALUES (?,?,?,\'admin\',?)').run(membershipId,orgId,userId,at);
  audit(orgId,membershipId,'organization.created','organization',orgId,null,{name:organization,timeZone});
});
console.log(`Created administrator ${email} for ${organization} (${timeZone}).`);
