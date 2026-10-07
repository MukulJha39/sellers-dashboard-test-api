import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/db/connect';
import { resetTransactionSupport } from '../src/db/transaction';

beforeAll(async () => {
  await connectDatabase(process.env.MONGODB_URI as string, 1);
  // Detected per connection, so the cache starts clean for each test file.
  resetTransactionSupport();
});

afterEach(async () => {
  // Each test starts from an empty database so ordering can never create false passes.
  const collections = await mongoose.connection.db?.collections();
  if (!collections) return;
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
});

afterAll(async () => {
  await disconnectDatabase();
});
