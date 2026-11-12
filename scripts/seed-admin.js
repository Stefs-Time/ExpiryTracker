/**
 * Create, promote, re-password or demote a platform admin.
 *
 *   npm run admin:seed -- --email admin@example.com                 # prompts for a password if the account is new
 *   npm run admin:seed -- --email admin@example.com --name "Stef"
 *   npm run admin:seed -- --email admin@example.com --reset-password  # set a new password (prompts)
 *   npm run admin:seed -- --email someone@example.com --demote
 *
 * Non-interactive (CI / `railway run`): set ADMIN_PASSWORD in the environment instead of typing it.
 * Promoting an existing account keeps its password; only --reset-password changes it.
 */
import { parseArgs } from 'node:util';
import readline from 'node:readline';
import { pool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { seedAdmin, demoteAdmin } from '../src/services/admin.js';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    'reset-password': { type: 'boolean', default: false },
    demote: { type: 'boolean', default: false },
  },
});

const email = String(values.email || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: npm run admin:seed -- --email <address> [--name "Name"] [--reset-password] [--demote]');
  process.exit(1);
}

/** Read a password from the TTY without echoing it. */
function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function getPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (!process.stdin.isTTY) throw new Error('No TTY: set ADMIN_PASSWORD in the environment');
  const a = await promptHidden('New admin password (min 12 chars): ');
  const b = await promptHidden('Repeat password: ');
  if (a !== b) throw new Error('Passwords do not match');
  return a;
}

try {
  await migrate();
  if (values.demote) {
    const ok = await demoteAdmin(email);
    console.log(ok ? `Demoted ${email} to a normal user.` : `${email} is not an admin; nothing to do.`);
  } else {
    const { rows } = await pool.query('SELECT 1 FROM users WHERE email = $1', [email]);
    const needsPassword = !rows.length || values['reset-password'];
    const password = needsPassword ? await getPassword() : undefined;
    if (password !== undefined && (password.length < 12 || password.length > 128)) {
      throw new Error('Admin password must be 12–128 characters');
    }
    const { action } = await seedAdmin({
      email,
      password,
      displayName: values.name || process.env.ADMIN_NAME || 'Platform Admin',
      resetPassword: values['reset-password'],
    });
    const messages = {
      created: `Created platform admin ${email}.`,
      promoted: `Promoted existing account ${email} to platform admin${values['reset-password'] ? ' and set a new password' : ' (password unchanged)'}.`,
      password_updated: `Updated the password for admin ${email} and signed out its sessions.`,
      unchanged: `${email} is already a platform admin; nothing changed.`,
    };
    console.log(messages[action]);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
