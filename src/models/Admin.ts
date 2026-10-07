import bcrypt from 'bcrypt';
import { Schema, model, type Document, type Model, type Types } from 'mongoose';

export const ADMIN_STATUSES = ['active', 'suspended'] as const;
export type AdminStatus = (typeof ADMIN_STATUSES)[number];

const BCRYPT_ROUNDS = 12;

export interface AdminDocument extends Document<Types.ObjectId> {
  name: string;
  email: string;
  passwordHash: string;
  roleId: Types.ObjectId;
  status: AdminStatus;
  /**
   * Set when someone else chose this account's password: at creation, or after a reset.
   * While it is true the admin can reach only their own profile and the change-password
   * endpoint, so a password the creator knows is never a working password for long.
   */
  mustChangePassword: boolean;
  passwordChangedAt?: Date | null;
  lastLoginAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  setPassword(plain: string): Promise<void>;
  verifyPassword(plain: string): Promise<boolean>;
}

const adminSchema = new Schema<AdminDocument>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true, maxlength: 160 },
    passwordHash: { type: String, required: true, select: false },
    roleId: { type: Schema.Types.ObjectId, ref: 'Role', required: true },
    status: { type: String, required: true, enum: ADMIN_STATUSES, default: 'active' },
    mustChangePassword: { type: Boolean, required: true, default: false },
    passwordChangedAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
  },
  {
    collection: 'admins',
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        delete ret.passwordHash;
        return ret;
      },
    },
  },
);

adminSchema.index({ status: 1, createdAt: -1 });
// The team list filters by role and sorts by name, and the lockout guards count active
// admins per role.
adminSchema.index({ roleId: 1, status: 1 });

adminSchema.methods.setPassword = async function setPassword(this: AdminDocument, plain: string): Promise<void> {
  this.passwordHash = await bcrypt.hash(plain, BCRYPT_ROUNDS);
};

adminSchema.methods.verifyPassword = async function verifyPassword(
  this: AdminDocument,
  plain: string,
): Promise<boolean> {
  if (!this.passwordHash) return false;
  return bcrypt.compare(plain, this.passwordHash);
};

export const Admin: Model<AdminDocument> = model<AdminDocument>('Admin', adminSchema);
