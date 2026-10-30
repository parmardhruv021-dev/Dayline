import '../src/env.mjs';
import { db } from '../src/db.mjs';
const versions = db.prepare('SELECT version,applied_at FROM schema_migrations ORDER BY version').all();
console.log(`Database ready at ${process.env.DATABASE_PATH || './data/dayline.sqlite'}`);
for (const row of versions) console.log(`${row.version} ${row.applied_at}`);
