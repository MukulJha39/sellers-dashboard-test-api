import type { Request, RequestHandler, Response } from 'express';
import ExcelJS from 'exceljs';
import { AppError } from '../../utils/AppError';
import { REPORTS, columnKey, type ExportColumn, type ReportKey, type ReportScope } from './reports';

/**
 * Excel downloads of the list screens, for sharing on WhatsApp or email.
 *
 * An export is the list endpoint behind the screen, read page by page: the same
 * permission check, the same query validation, the same filters, sort and presenters.
 * So a downloaded file always holds exactly the rows the screen shows, and a new filter
 * on a list is in its export without anyone remembering to add it.
 */

/** Large enough for any real report, small enough that one request cannot run away. */
export const MAX_EXPORT_ROWS = 10_000;
const PAGE_SIZE = 100;

type ListHandler = (req: Request, res: Response) => Promise<void>;

interface CapturedPage {
  items: Record<string, unknown>[];
  meta: { hasNextPage: boolean; total: number };
}

/** Runs a list handler for one page and returns what it would have sent. */
async function readPage(list: ListHandler, req: Request, page: number): Promise<CapturedPage> {
  // The handler reads `req.query`; everything else (the signed-in user above all)
  // comes from the real request through the prototype.
  const pageRequest = Object.create(req) as Request;
  Object.defineProperty(pageRequest, 'query', {
    value: { ...req.query, page: String(page), limit: String(PAGE_SIZE) },
    enumerable: true,
  });

  let body: unknown;
  const capture = {
    status() {
      return capture;
    },
    json(payload: unknown) {
      body = payload;
      return capture;
    },
  } as unknown as Response;

  await list(pageRequest, capture);

  const data = (body as { data?: CapturedPage } | undefined)?.data;
  if (!data || !Array.isArray(data.items)) throw AppError.internal();
  return data;
}

async function collectRows(list: ListHandler, req: Request) {
  const rows: Record<string, unknown>[] = [];
  let total = 0;
  for (let page = 1; rows.length < MAX_EXPORT_ROWS; page += 1) {
    const result = await readPage(list, req, page);
    total = result.meta.total;
    rows.push(...result.items);
    if (!result.meta.hasNextPage || result.items.length === 0) break;
  }
  return { rows: rows.slice(0, MAX_EXPORT_ROWS), total };
}

/**
 * Minutes east of UTC for the reader, so times read as their own clock. Clients send
 * `utcOffsetMinutes` (330 for India); without it the file uses India time, which is
 * where the businesses this serves are.
 */
function readOffset(req: Request): number {
  const raw = Number(req.query.utcOffsetMinutes);
  return Number.isFinite(raw) && Math.abs(raw) <= 14 * 60 ? Math.round(raw) : 330;
}

/** What a masked amount reads as, the same as the panel's "Hide amounts". */
export const MASKED_AMOUNT = '₹ XxXx';

function cellValue(
  column: ExportColumn,
  row: Record<string, unknown>,
  offsetMinutes: number,
  maskAmounts: boolean,
) {
  const value = column.value(row as never);
  if (value === null || value === undefined || value === '') return null;

  switch (column.kind) {
    case 'money':
      if (maskAmounts) return MASKED_AMOUNT;
      return typeof value === 'number' ? value / 100 : null;
    case 'number':
      return typeof value === 'number' ? value : Number(value);
    case 'date': {
      // A calendar day: kept as that day, never shifted by a time zone.
      const day = String(value).slice(0, 10);
      const parsed = new Date(`${day}T00:00:00.000Z`);
      return Number.isNaN(parsed.getTime()) ? String(value) : parsed;
    }
    case 'datetime': {
      const parsed = new Date(String(value));
      return Number.isNaN(parsed.getTime()) ? String(value) : new Date(parsed.getTime() + offsetMinutes * 60_000);
    }
    case 'boolean':
      return value ? 'Yes' : 'No';
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

const NUMBER_FORMATS: Partial<Record<NonNullable<ExportColumn['kind']>, string>> = {
  money: '"₹"#,##0.00;-"₹"#,##0.00',
  number: '#,##0.###',
  date: 'dd-mmm-yyyy',
  datetime: 'dd-mmm-yyyy hh:mm',
};

function describeFilters(req: Request): string {
  const ignored = new Set(['page', 'limit', 'utcOffsetMinutes', 'columns', 'maskAmounts']);
  const parts = Object.entries(req.query)
    .filter(([key, value]) => !ignored.has(key) && value !== undefined && value !== '')
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`);
  return parts.length > 0 ? parts.join(' · ') : 'None';
}

export async function buildWorkbook(input: {
  title: string;
  columns: ExportColumn[];
  rows: Record<string, unknown>[];
  total: number;
  filters: string;
  offsetMinutes: number;
  generatedBy: string;
  maskAmounts?: boolean;
}): Promise<Buffer> {
  const maskAmounts = input.maskAmounts ?? false;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Inperge';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(input.title.slice(0, 31), {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = input.columns.map((column) => ({
    header: column.header,
    key: column.header,
    width: column.width ?? Math.max(12, column.header.length + 4),
    ...(column.kind && NUMBER_FORMATS[column.kind] && !(maskAmounts && column.kind === 'money')
      ? { style: { numFmt: NUMBER_FORMATS[column.kind] } }
      : {}),
  }));

  for (const row of input.rows) {
    sheet.addRow(input.columns.map((column) => cellValue(column, row, input.offsetMinutes, maskAmounts)));
  }

  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF027151' } };
  header.alignment = { vertical: 'middle' };
  header.height = 20;
  if (input.rows.length > 0) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: input.columns.length } };
  }

  // A short cover note, so a file forwarded on WhatsApp still says what it is.
  const about = workbook.addWorksheet('About');
  about.columns = [{ width: 22 }, { width: 70 }];
  const generatedAt = new Date(Date.now() + input.offsetMinutes * 60_000);
  const truncated = input.total > input.rows.length;
  about.addRows([
    ['Report', input.title],
    ['Generated', generatedAt],
    ['Generated by', input.generatedBy],
    ['Filters', input.filters],
    ['Rows', truncated ? `${input.rows.length} of ${input.total} (narrow the filters to export the rest)` : input.rows.length],
    ['Amounts', !input.columns.some((column) => column.kind === 'money') ? 'None in this report' : maskAmounts ? `Hidden (shown as ${MASKED_AMOUNT})` : 'In rupees'],
  ]);
  about.getColumn(1).font = { bold: true };
  about.getCell('B2').numFmt = 'dd-mmm-yyyy hh:mm';

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

function fileName(report: string, offsetMinutes: number): string {
  const day = new Date(Date.now() + offsetMinutes * 60_000).toISOString().slice(0, 10);
  return `inperge-${report}-${day}.xlsx`;
}

function actorName(req: Request): string {
  if (req.admin) return `${req.admin.name} (admin)`;
  return 'Merchant app';
}

function queryList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : '';
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

/**
 * The columns a download asked for, in the report's own order. Without `columns`, every
 * column; an unknown key or an empty choice is refused rather than silently ignored.
 */
function chooseColumns(all: ExportColumn[], requested: string[]): ExportColumn[] {
  if (requested.length === 0) return all;
  const known = new Set(all.map(columnKey));
  const unknown = requested.filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'columns', message: `Unknown column: ${unknown.join(', ')}.` },
    ]);
  }
  const wanted = new Set(requested);
  return all.filter((column) => wanted.has(columnKey(column)));
}

function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === '1';
}

/** Lists a report's columns, so a client can let the reader choose which to download. */
export function exportColumns(input: { report: ReportKey; scope: ReportScope }): RequestHandler {
  const spec = REPORTS[input.report];
  return (_req, res) => {
    res.status(200).json({
      success: true,
      data: {
        report: input.report,
        title: spec.title,
        columns: spec.columns(input.scope).map((column) => ({
          key: columnKey(column),
          header: column.header,
          kind: column.kind ?? 'text',
        })),
      },
    });
  };
}

/**
 * An Express handler that downloads one report as an .xlsx file.
 *
 * Options, alongside the list's own filters: `columns` (comma-separated keys from the
 * columns endpoint; all when omitted) and `maskAmounts=true` (every amount written as
 * ₹ XxXx, for a file that should not carry prices).
 */
export function excelExport(input: { report: ReportKey; scope: ReportScope; list: ListHandler }): RequestHandler {
  const spec = REPORTS[input.report];

  return async (req, res, next) => {
    try {
      const offsetMinutes = readOffset(req);
      const { rows, total } = await collectRows(input.list, req);
      const columns = chooseColumns(spec.columns(input.scope), queryList(req.query.columns));
      const maskAmounts = readBoolean(req.query.maskAmounts);

      const buffer = await buildWorkbook({
        title: spec.title,
        columns,
        rows,
        total,
        filters: describeFilters(req),
        offsetMinutes,
        generatedBy: actorName(req),
        maskAmounts,
      });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName(input.report, offsetMinutes)}"`);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      res.setHeader('X-Export-Rows', String(rows.length));
      res.setHeader('X-Export-Total', String(total));
      res.status(200).send(buffer);
    } catch (error) {
      next(error);
    }
  };
}
