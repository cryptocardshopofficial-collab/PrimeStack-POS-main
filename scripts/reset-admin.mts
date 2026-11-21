import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const p = new PrismaClient();
const hash = await bcrypt.hash('Admin191@prime', 12);
const pinHash = await bcrypt.hash('303030', 10);

const existing = await p.user.findFirst({ 
  where: { role: 'SUPER_ADMIN' },
  orderBy: { createdAt: 'asc' }
});

if (existing) {
  await p.user.update({
    where: { id: existing.id },
    data: { email: 'admin@primestack.com', passwordHash: hash, portalPinHash: pinHash }
  });
  console.log('Updated admin:', existing.email, '->', 'admin@primestack.com');
} else {
  // Create fresh
  await p.user.create({
    data: {
      email: 'admin@primestack.com',
      username: 'admin',
      passwordHash: hash,
      portalPinHash: pinHash,
      fullName: 'System Administrator',
      role: 'SUPER_ADMIN',
      preferredLang: 'en',
      isActive: true,
    }
  });
  console.log('Created new admin: admin@primestack.com');
}

await p.$disconnect();