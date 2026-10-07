import { TERMINAL_ORDER_STATUSES } from '../../config/orders';
import type { AuditLogDocument } from '../../models/AuditLog';
import type { OrderDocument, OrderInstallment } from '../../models/Order';
import { fromThousandths } from '../../utils/quantity';
import { derivePaymentState, outstandingMinor } from '../payments/paymentEngine';
import { nextDueInstallment } from './orderService';

/**
 * API views for orders and their installment plans.
 *
 * Everything a client needs is computed here, once: `outstandingMinor`, `paymentState`
 * and the next-due installment. Leaving those to be derived on three surfaces is how the
 * app, the admin panel and a report start disagreeing about the same order.
 */

function presentInstallment(
  installment: OrderInstallment,
  now: Date,
  isNextDue: boolean,
) {
  const outstanding = Math.max(0, installment.amountMinor - installment.paidMinor);

  return {
    number: installment.number,
    amountMinor: installment.amountMinor,
    paidMinor: installment.paidMinor,
    outstandingMinor: outstanding,
    dueDate: installment.dueDate.toISOString(),
    status: installment.status,
    // Derived from the date, never stored: a flag would need a job to maintain, and a
    // row the job had not reached would be wrong.
    isOverdue: outstanding > 0 && installment.dueDate.getTime() < now.getTime(),
    /** The one the PRD asks to be made obvious (section 9). */
    isNextDue,
    notes: installment.notes ?? null,
    reminderSentAt: installment.reminderSentAt
      ? installment.reminderSentAt.toISOString()
      : null,
  };
}

export function presentOrder(order: OrderDocument, now: Date = new Date()) {
  const closed = TERMINAL_ORDER_STATUSES.has(order.status);
  const nextDue = nextDueInstallment(order);

  return {
    id: String(order._id),
    reference: order.reference,

    customerId: order.customerId ? String(order.customerId) : null,
    /** Null for an anonymous counter sale, which the PRD allows (section 8). */
    customerName: order.customerName ?? null,

    lines: order.lines.map((line) => ({
      lineType: line.lineType,
      subjectId: String(line.subjectId),
      // The name and rate as they were when the order was written.
      name: line.name,
      unit: line.unit ?? null,
      billingUnit: line.billingUnit ?? null,
      quantity: fromThousandths(line.quantityThousandths),
      unitRateMinor: line.unitRateMinor,
      durationMinutes: line.durationMinutes ?? null,
      lineTotalMinor: line.lineTotalMinor,
    })),

    subtotalMinor: order.subtotalMinor,
    discountType: order.discountType,
    discountPercent: order.discountPercent ?? null,
    discountMinor: order.discountMinor,
    taxPercent: order.taxPercent ?? null,
    taxMinor: order.taxMinor,
    totalMinor: order.totalMinor,
    paidMinor: order.paidMinor,
    outstandingMinor: outstandingMinor(order.totalMinor, order.paidMinor),

    status: order.status,
    /** Whether this order is currently holding stock out of inventory. */
    stockCommitted: order.stockCommitted,
    stockCommittedAt: order.stockCommittedAt ? order.stockCommittedAt.toISOString() : null,

    orderDate: order.orderDate.toISOString(),
    dueDate: order.dueDate ? order.dueDate.toISOString() : null,
    completedAt: order.completedAt ? order.completedAt.toISOString() : null,
    cancelledAt: order.cancelledAt ? order.cancelledAt.toISOString() : null,
    cancelledReason: order.cancelledReason ?? null,
    returnedAt: order.returnedAt ? order.returnedAt.toISOString() : null,
    returnedReason: order.returnedReason ?? null,

    notes: order.notes ?? null,

    paymentStatus: order.paymentStatus,
    /**
     * What a client displays. `paymentStatus` is the stored, settled state; this folds in
     * the due date, so an unpaid order past its date reads as overdue without anything
     * having to write to the row. A closed order is never overdue.
     */
    paymentState: closed
      ? order.paymentStatus
      : derivePaymentState({
          paymentStatus: order.paymentStatus,
          dueDate: order.dueDate ?? null,
          now,
        }),

    installments: order.installments.map((installment) =>
      presentInstallment(installment, now, nextDue?.number === installment.number),
    ),
    nextDueInstallment: nextDue ? presentInstallment(nextDue, now, true) : null,

    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

/**
 * One activity entry as the merchant sees it.
 *
 * `ip` and `requestId` are deliberately left out: they are operational detail for the
 * admin audit screen, not something a merchant has any use for, and a request id is the
 * sort of thing that invites support questions rather than answering them.
 */
export function presentOrderActivity(entry: AuditLogDocument) {
  return {
    id: String(entry._id),
    action: entry.action,
    summary: entry.summary,
    /** `merchant`, `admin` or `system`, so support's hand in it is visible. */
    actorType: entry.actorType,
    actorLabel: entry.actorLabel,
    changes: entry.changes.map((change) => ({
      field: change.field,
      from: change.from ?? null,
      to: change.to ?? null,
    })),
    at: entry.createdAt.toISOString(),
  };
}
