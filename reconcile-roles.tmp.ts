
import { connectDatabase, disconnectDatabase } from './src/db/connect';
import { ROLE_SEEDS, ALL_PERMISSIONS } from './src/config/permissions';
import { Role } from './src/models/Role';

async function main() {
  await connectDatabase();
  const apply = true;
  console.log('catalogue size:', ALL_PERMISSIONS.length);

  for (const seed of ROLE_SEEDS) {
    const existing = await Role.findOne({ slug: seed.slug });
    if (!existing) {
      console.log('  MISSING  ' + seed.slug + ' (a full seed would create it)');
      continue;
    }
    const had = new Set(existing.permissions);
    const wants = new Set(seed.permissions);
    const adding = seed.permissions.filter((p) => !had.has(p));
    const removing = existing.permissions.filter((p) => !wants.has(p));

    if (adding.length === 0 && removing.length === 0) {
      console.log('  ok       ' + seed.slug.padEnd(18) + existing.permissions.length);
      continue;
    }
    console.log(
      '  CHANGE   ' + seed.slug.padEnd(18) +
      existing.permissions.length + ' -> ' + seed.permissions.length +
      (adding.length ? '  +[' + adding.join(', ') + ']' : '') +
      (removing.length ? '  -[' + removing.join(', ') + ']' : ''),
    );

    if (apply) {
      existing.permissions = [...seed.permissions];
      existing.name = seed.name;
      existing.description = seed.description;
      existing.isSystem = true;
      await existing.save();
    }
  }

  console.log(apply ? 'applied' : '(dry run - pass --apply to write)');
  await disconnectDatabase();
}

main().catch((e) => { console.error(e); process.exit(1); });
