import { Schema, model, type Document, type Model, type Types } from 'mongoose';
import { ALL_PERMISSIONS, type Permission } from '../config/permissions';

export interface RoleDocument extends Document<Types.ObjectId> {
  slug: string;
  name: string;
  description: string;
  permissions: Permission[];
  /** System roles are seeded and cannot be deleted. */
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const roleSchema = new Schema<RoleDocument>(
  {
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true, maxlength: 40 },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, required: true, trim: true, maxlength: 300 },
    permissions: {
      type: [String],
      required: true,
      default: [],
      validate: {
        validator: (values: string[]) => values.every((value) => (ALL_PERMISSIONS as string[]).includes(value)),
        message: 'Permissions must come from the permission catalogue.',
      },
    },
    isSystem: { type: Boolean, required: true, default: false },
  },
  {
    collection: 'roles',
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

export const Role: Model<RoleDocument> = model<RoleDocument>('Role', roleSchema);
