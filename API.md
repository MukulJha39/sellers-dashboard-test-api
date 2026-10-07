# API contract — Phases 1 to 4

Base URL: `http://localhost:4100` (ports 4000 and 3000 were already taken on the
development machine, so the API listens on 4100 and the admin panel on 3100)
API prefix: `/api/v1`

Terminology: the people who use the mobile app are **Merchants** (`prd.md` section 42). The MongoDB collection behind them is still named `users`; nothing above persistence uses that word.

---

## Conventions

**Success**

```json
{ "success": true, "data": { } }
```

**Paginated success**

```json
{
  "success": true,
  "data": {
    "items": [],
    "meta": { "page": 1, "limit": 20, "total": 0, "totalPages": 0, "hasNextPage": false }
  }
}
```

**Error**

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Please correct the highlighted fields.",
    "details": [{ "field": "phone", "message": "Enter your phone number." }],
    "meta": { "retryAfterSeconds": 24 }
  },
  "requestId": "b2e1…"
}
```

Clients branch on `error.code`, never on message text. `details` maps onto form fields; `meta` carries extra context such as `retryAfterSeconds` or `attemptsRemaining`.

### Money

Every amount is a **whole number of minor units** — paise for INR, cents for USD — and
the field name carries a `Minor` suffix. `"sellingPriceMinor": 45000` is ₹450.00.

There are no decimal amounts anywhere in the API. Floating-point money accumulates
error once you start summing it, and totals that disagree with the sum of their lines
are the kind of defect a merchant notices and cannot explain. Clients divide by 100 for
display and multiply back on input; nothing in between ever holds a fraction.

A client that sends a fractional amount gets `422 VALIDATION_ERROR`.

### Payment state

Every payable — a purchase now, an order from Phase 4 — carries two fields:

| Field | Values | Meaning |
|---|---|---|
| `paymentStatus` | `unpaid`, `partially_paid`, `fully_paid` | The **stored** state, settled by the amounts alone |
| `paymentState` | the three above, plus `overdue` | What a client **displays** |

`overdue` is deliberately not stored. It is true when a payable is not fully paid and
its due date has passed, which changes with the clock rather than with a write. Storing
it would need a nightly job to flip rows, and any row the job had not reached yet would
be lying. Clients show `paymentState`; filtering by it is a query
(`paymentStatus != fully_paid AND dueDate < now`), which the indexes serve.

A fully paid payable is never overdue, however late it was settled.

### Quantities

A quantity is a **decimal with at most three decimal places**, sent and returned as a
JSON number: `12.345`. Internally it is stored as a whole number of thousandths, which
is why the limit is three places and not an arbitrary precision.

Some units are counted rather than measured. `GET /catalog/meta` marks these with
`wholeNumbersOnly`, and a fractional quantity against one of them is rejected — half a
piece is not a thing a shop has. Clients read that flag rather than keeping their own
list of which units are countable.

### Error codes

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 422 | One or more fields are invalid; see `details` |
| `UNAUTHENTICATED` | 401 | No usable credentials |
| `INVALID_TOKEN` | 401 | Token malformed, revoked or for the wrong audience |
| `TOKEN_EXPIRED` | 401 | Token expired; refresh or sign in again |
| `FORBIDDEN` | 403 | Authenticated but not permitted |
| `ACCOUNT_SUSPENDED` | 403 | Merchant or admin account is suspended |
| `PASSWORD_CHANGE_REQUIRED` | 403 | Admin still holds a password set for them; only `/admin/auth/me`, `/admin/auth/logout` and `/admin/auth/change-password` work |
| `NOT_FOUND` | 404 | No such record or endpoint |
| `CONFLICT` | 409 | Duplicate or conflicting state |
| `PHONE_IMMUTABLE` | 409 | An attempt was made to change a verified phone number |
| `ALREADY_REGISTERED` | 409 | That phone number already has a merchant |
| `OTP_INVALID` | 400 | Wrong code (`meta.attemptsRemaining`) |
| `OTP_EXPIRED` | 400 | Code expired |
| `OTP_ALREADY_USED` | 400 | Code already consumed or superseded |
| `OTP_ATTEMPTS_EXCEEDED` | 400 | Attempt ceiling reached; request a new code |
| `OTP_RESEND_TOO_SOON` | 429 | Inside the resend cooldown (`meta.retryAfterSeconds`) |
| `RATE_LIMITED` | 429 | Too many requests |
| `UPLOAD_REJECTED` | 400 | File missing, too large, or not a real image |
| `INTERNAL_ERROR` | 500 | Unexpected failure; `requestId` identifies it in the logs |

`CONFLICT` covers three Phase 2 cases, each with the detail a client needs:

| Situation | `meta` |
|---|---|
| A stock change would leave a negative balance | `available`, `unit` |
| A quantity field was sent to a details endpoint | — |
| A duplicate name or SKU within one merchant | — |

`VALIDATION_ERROR` and `CONFLICT` messages name the specific problem and are written in
plain language, so a client may show `error.message` directly when it has no localized
string for the case. Per-case codes that would let clients localize all of these are a
Phase 5 item.

### Authentication

`Authorization: Bearer <accessToken>`

Merchant and admin tokens are separate audiences — a merchant token is rejected on admin routes and vice versa. Token payload:

```json
{
  "accessToken": "…",
  "refreshToken": "…",
  "accessTokenExpiresIn": 900,
  "refreshTokenExpiresIn": 2592000,
  "tokenType": "Bearer"
}
```

Refresh tokens rotate. Presenting a previously used refresh token revokes the whole session, because that only happens if a token was captured.

---

## Onboarding and authentication (merchant app)

### `POST /api/v1/auth/otp/request`

Step 1. Country code and phone number are sent separately and stay separate in storage.

Request: `{ "countryCode": "+91", "phone": "9876543210" }`

`201`:

```json
{
  "success": true,
  "data": {
    "otpId": "66f…",
    "maskedPhone": "+91********10",
    "expiresInSeconds": 300,
    "resendAfterSeconds": 30,
    "maxAttempts": 5,
    "devCode": "123456"
  }
}
```

`devCode` appears only when `OTP_EXPOSE_IN_RESPONSE` is on, which is impossible in production. Requesting a new code supersedes any earlier one for that number.

Errors: `VALIDATION_ERROR`, `OTP_RESEND_TOO_SOON`, `RATE_LIMITED`.

### `POST /api/v1/auth/otp/verify`

Steps 2 and 3. Verifies the code, then branches.

Request: `{ "otpId": "66f…", "code": "123456" }`

`200` — phone already known, signed straight in:

```json
{ "success": true, "data": { "status": "authenticated", "merchant": { }, "tokens": { } } }
```

`200` — new phone, continue to registration:

```json
{
  "success": true,
  "data": {
    "status": "registration_required",
    "registrationToken": "…",
    "registrationTokenExpiresIn": 900,
    "countryCode": "+91",
    "phone": "9876543210"
  }
}
```

The registration token authorises exactly one action: registering that verified number.

Errors: `OTP_INVALID`, `OTP_EXPIRED`, `OTP_ALREADY_USED`, `OTP_ATTEMPTS_EXCEEDED`, `ACCOUNT_SUSPENDED`.

### `POST /api/v1/auth/register`

Step 4. Accepts JSON or `multipart/form-data` when a photo is attached.

| Field | Required | Notes |
|---|---|---|
| `registrationToken` | yes | From the verify step |
| `firstName` | **yes** | 1–60 characters |
| `lastName` | **yes** | 1–60 characters |
| `gender` | **yes** | `male` \| `female` \| `other` \| `prefer_not_to_say` |
| `photo` | no | PNG, JPG or WebP, multipart file part |
| `locale` | no | Defaults to `en` |

The phone number comes from the token. Sending `phone`, `countryCode` or `phoneE164` in the body is rejected.

`201`: `{ "success": true, "data": { "merchant": { }, "tokens": { } } }`

Errors: `VALIDATION_ERROR`, `INVALID_TOKEN`, `TOKEN_EXPIRED`, `ALREADY_REGISTERED`, `UPLOAD_REJECTED`.

### `POST /api/v1/auth/refresh`

Request: `{ "refreshToken": "…" }` → `200` `{ "data": { "tokens": { } } }`

### `POST /api/v1/auth/logout`

Authenticated. Revokes the current session. → `200` `{ "data": { "loggedOut": true } }`

---

## Merchant profile

### `GET /api/v1/merchants/me`

`200` `{ "data": { "merchant": MerchantView } }`

**MerchantView**

```json
{
  "id": "66f…",
  "countryCode": "+91",
  "phone": "9876543210",
  "phoneE164": "+919876543210",
  "phoneEditable": false,
  "firstName": "Anita",
  "lastName": "Desai",
  "fullName": "Anita Desai",
  "gender": "female",
  "photoUrl": null,
  "status": "active",
  "locale": "en",
  "themeMode": "system",
  "phoneVerifiedAt": "2026-10-01T12:00:00.000Z",
  "lastLoginAt": "2026-10-01T12:00:00.000Z",
  "createdAt": "2026-10-01T12:00:00.000Z",
  "updatedAt": "2026-10-01T12:00:00.000Z"
}
```

`phoneEditable` is always `false`. It is in the contract so no client ever renders an edit affordance for the verified number.

### `PATCH /api/v1/merchants/me`

Editable: `firstName`, `lastName`, `gender`, `locale`, `themeMode`. At least one is required.

Sending `phone`, `countryCode`, `phoneE164` or `phoneVerifiedAt` returns `409 PHONE_IMMUTABLE` and changes nothing.

### `PUT /api/v1/merchants/me/photo`

`multipart/form-data` with a `photo` part. Replaces the existing photo and deletes the old file.

### `DELETE /api/v1/merchants/me/photo`

Removes the optional photo.

---

## Business profile (merchant app)

One business per merchant. Every field is optional: a merchant can use the whole app
with an empty profile and fill it in when they have a reason to (`prd.md` section 5).

### `GET /api/v1/business`

`200` `{ "data": { "business": BusinessView } }`

Reading **creates** an empty profile on first use. That is deliberate: setup can then
start from any single field, rather than from a form that demands everything at once.

**BusinessView**

```json
{
  "id": "66f…",
  "name": "Desai Textiles",
  "logoUrl": null,
  "category": "tailoring",
  "taxNumber": null,
  "address": { "line1": null, "line2": null, "city": "Pune", "state": null, "postalCode": null, "country": null },
  "contact": { "email": null, "countryCode": "+91", "phone": "2025550123", "website": null },
  "invoice": { "showLogo": true, "showAddress": true, "showTaxNumber": false, "footerNote": null },
  "currency": "INR",
  "defaultPaymentTermsDays": null,
  "lowStockAlertsEnabled": true,
  "completion": { "total": 6, "completed": 2, "percent": 33, "missing": ["taxNumber", "address"] },
  "createdAt": "2026-10-01T12:00:00.000Z",
  "updatedAt": "2026-10-01T12:00:00.000Z"
}
```

`completion` exists so a client can prompt gently. It is guidance, never a gate: no
endpoint refuses work because a profile is incomplete.

### `PATCH /api/v1/business`

Accepts the flat shape (`city`, `contactEmail`, `invoiceShowLogo`, …) and also the
nested shape it serves back (`address.city`, `contact.email`, `invoice.showLogo`), so a
client can post back the object it received.

- **`null` clears a field.** Presence is decided by whether the key is in the body, not
  by whether its value is non-null — otherwise a detail could be filled in and never
  emptied again.
- `currency` and the three `invoice.show…` switches have no empty state, so a `null`
  there means "leave it alone" rather than "clear it".
- An empty body is `422`: there is nothing to save.
- A contact number requires a country code alongside it (`details[].field` is
  `contact.countryCode`).
- Sending `phone`, `countryCode` or `phoneE164` returns `409 PHONE_IMMUTABLE`. The
  business contact number is a separate, editable field; the merchant's verified
  sign-in number is not part of this payload at all.

### `PUT /api/v1/business/logo` · `DELETE /api/v1/business/logo`

`multipart/form-data` with a `logo` part. Same handling as the merchant photo.

---

## Catalog (merchant app)

Three kinds of record, each with its own resource:

| Kind | What it is | Holds stock |
|---|---|---|
| **Item** | A physical thing the merchant sells | Yes |
| **Service** | Work charged by time, session, unit or package | **No** |
| **Raw material** | An input bought before making or selling something | Yes |

A service carries no stock fields at all. That absence is the guarantee: there is no
field to set and no endpoint to call, so selling a service can never move a quantity.

### `GET /api/v1/catalog/meta`

The vocabulary the clients must not hard-code: units (each with `wholeNumbersOnly`),
billing units, adjustment reasons, business categories, supported currencies, and from
Phase 3 the payment methods, payment states and contact channels. The admin panel reads
the same document at `GET /api/v1/admin/catalog/meta`.

One document rather than several: it is fetched once at launch, and one place that can
drift is better than four.

### `GET /api/v1/catalog/summary`

Counts by state, for the dashboard.

```json
{ "summary": {
  "items": { "active": 12, "lowStock": 2, "outOfStock": 1, "archived": 3 },
  "services": { "active": 4, "inactive": 1, "archived": 0 },
  "materials": { "active": 6, "lowStock": 1, "expiringSoon": 2, "archived": 0 },
  "categories": 5
} }
```

### `GET /api/v1/catalog/low-stock?limit=10`

The records at or below their threshold, worst first. `{ "records": [ … ] }`.

### Categories

`GET /api/v1/categories?kind=item|service|material&includeArchived=true`
`POST /api/v1/categories` · `PATCH /api/v1/categories/:id`
`POST /api/v1/categories/:id/archive` · `POST /api/v1/categories/:id/restore`

A category belongs to exactly one kind, so an item category is never offered for a
service. Names are unique per kind per merchant; re-using an archived name restores it
rather than creating a duplicate. Archiving a category leaves the records filed under
it untouched — `usageCount` on the response says how many that is, so a client can tell
the merchant before they archive.

### Items

`GET /api/v1/items` — `search`, `categoryId`, `archived`, `lowStock`, `page`, `limit`, `sort`
`POST /api/v1/items` · `GET /api/v1/items/:id` · `PATCH /api/v1/items/:id`
`POST /api/v1/items/:id/archive` · `POST /api/v1/items/:id/restore`
`PUT /api/v1/items/:id/image` · `DELETE /api/v1/items/:id/image`

**ItemView**

```json
{
  "id": "66f…",
  "name": "Cotton bedsheet",
  "categoryId": null,
  "categoryName": null,
  "description": null,
  "imageUrl": null,
  "sku": "BED-001",
  "barcode": null,
  "unit": "piece",
  "trackStock": true,
  "quantity": 20,
  "totalReceived": 25,
  "lowStockThreshold": 5,
  "isLowStock": false,
  "isOutOfStock": false,
  "sellingPriceMinor": 45000,
  "costPriceMinor": 30000,
  "taxRatePercent": null,
  "archived": false,
  "createdAt": "2026-10-01T12:00:00.000Z",
  "updatedAt": "2026-10-01T12:00:00.000Z"
}
```

`quantity` is **read-only**. `POST` accepts `openingQuantity`, which the server records
as an `opening` ledger entry; after that the only way the number moves is through the
stock endpoints below. `totalReceived` is everything ever taken in, which is not the
same as what is available now.

Searching treats the term as literal text, not as a pattern, so a merchant typing
`.` or `(` gets the records that contain those characters.

### Services

`GET /api/v1/services` — `search`, `categoryId`, `archived`, `isActive`, `billingUnit`, `page`, `limit`, `sort`
`POST /api/v1/services` · `GET /api/v1/services/:id` · `PATCH /api/v1/services/:id`
`POST /api/v1/services/:id/archive` · `POST /api/v1/services/:id/restore`
`PUT /api/v1/services/:id/image` · `DELETE /api/v1/services/:id/image`

`billingUnit` is one of `one_time`, `hourly`, `per_session`, `per_unit`, `package`.
`durationMinutes` is kept only for `hourly` and `per_session`; changing the billing
unit to one that carries no duration clears it rather than leaving a stale number.

`isActive` is availability — "off the menu for now" — and is separate from `archived`,
which retires the record.

### Raw materials

`GET /api/v1/materials` — `search`, `categoryId`, `archived`, `lowStock`, `expiringWithinDays`, `page`, `limit`, `sort`
`POST /api/v1/materials` · `GET /api/v1/materials/:id` · `PATCH /api/v1/materials/:id`
`POST /api/v1/materials/:id/archive` · `POST /api/v1/materials/:id/restore`
`PUT /api/v1/materials/:id/image` · `DELETE /api/v1/materials/:id/image`

Same stock fields as an item, plus `purchaseCostMinor`, `batchReference`, `expiryDate`
and `supplierName`. `supplierName` is free text for now; suppliers become records of
their own in Phase 3, and this field is what will migrate into them.

---

## Stock (merchant app)

An append-only ledger is the source of truth. The `quantity` on a record is a cached
projection of it, written in the same transaction as the movement, so the two cannot
drift.

### `POST /api/v1/stock/:subjectType/:subjectId/adjust`

`subjectType` is `item` or `material`. There is no `service`.

```json
{ "change": -3, "reason": "damaged", "note": "Water damage in storage" }
```

`change` is signed and non-zero. `reason` is **required** — a ledger nobody can
interpret is not worth keeping — and comes from `catalog/meta`: `damaged`, `lost`,
`expired`, `found`, `manual_correction`, `recount`, `other`. `opening_stock` is written
by the server when a record is created and cannot be chosen by hand.

`201` `{ "data": { "movement": StockMovementView } }`

A change that would leave a negative balance is `409 CONFLICT` with
`meta: { available, unit }`, and **nothing is written** — not the movement, not the
quantity. Negative stock is not a state a shop can be in, so it is not a state the
database is allowed to hold.

### `PUT /api/v1/stock/:subjectType/:subjectId/quantity`

Sets an exact figure, which is what a recount produces.

```json
{ "quantity": 27, "reason": "recount", "note": "Monthly count" }
```

The server records the **difference** as the movement, because that is what happened.
Setting 30 to 27 writes a movement of `-3`, not an entry that says "27".

### `GET /api/v1/stock/history`

`subjectType`, `subjectId`, `page`, `limit`. Newest first.

**StockMovementView**

```json
{
  "id": "66f…",
  "subjectType": "item",
  "subjectId": "66f…",
  "subjectName": "Cotton bedsheet",
  "type": "adjustment",
  "delta": -3,
  "balanceAfter": 17,
  "reason": "damaged",
  "note": "Water damage in storage",
  "actorType": "merchant",
  "actorLabel": "Anita Desai",
  "createdAt": "2026-10-01T12:00:00.000Z"
}
```

`type` is `opening`, `adjustment`, `receipt`, `sale`, `return` or `reversal`; the last
three arrive with purchases, orders and returns in later phases. `actorType` is
`merchant` or `admin`, so a client can tell the merchant when support changed something
on their behalf.

Ledger entries are immutable. A mistake is corrected by a further movement, never by
editing or deleting one.

### Quantity fields are refused, not ignored

`PATCH /api/v1/items/:id` and `PATCH /api/v1/materials/:id` return `409 CONFLICT` if the
body contains `quantity`, `quantityThousandths`, `totalReceived` or `isLowStock`, and
change nothing.

Refusing is the point. Silently dropping the field would let a client believe it had
written a quantity, and the ledger would then disagree with what the merchant was shown.
The same guard runs on the admin equivalents.

---

## Customers (merchant app)

The people the merchant sells to (PRD section 7). Phone number, both names and gender
are the core identity; everything else is optional, so a customer can be created
mid-order from four fields.

### `GET /api/v1/customers`

`search`, `tag`, `archived`, `outstanding`, `page`, `limit`, `sort`.

Search covers name, phone number, company and email, and treats the term as literal
text. `sort` accepts `firstName`, `createdAt`, `outstandingMinor`, `lastOrderAt`.

**CustomerView**

```json
{
  "id": "66f…",
  "countryCode": "+91",
  "phone": "9820012001",
  "phoneE164": "+919820012001",
  "firstName": "Kavita",
  "lastName": "Joshi",
  "fullName": "Kavita Joshi",
  "gender": "female",
  "email": null,
  "address": { "line1": null, "line2": null, "city": "Pune", "state": null, "postalCode": null, "country": null },
  "notes": null,
  "tags": ["regular"],
  "dateOfBirth": null,
  "companyName": null,
  "preferredChannel": "whatsapp",
  "language": "en",
  "outstandingMinor": 0,
  "orderCount": 0,
  "lastOrderAt": null,
  "archived": false,
  "createdAt": "2026-10-01T12:00:00.000Z",
  "updatedAt": "2026-10-01T12:00:00.000Z"
}
```

`outstandingMinor` is a projection of the customer's unpaid orders, maintained by the
payment engine. **It stays zero through Phase 3**, because nothing a customer can owe
for exists until orders arrive in Phase 4. The field is in the contract now so the
clients render the balance surfaces against a real shape rather than a placeholder.

`preferredChannel` is one of `sms`, `whatsapp`, `both`, `none`; `language` is `en` or
`hi`. Both come from `catalog/meta`.

### `POST /api/v1/customers`

Required: `countryCode`, `phone`, `firstName`, `lastName`, `gender`. Everything else is
optional.

**One customer per phone number per merchant.** The same person in two rows splits their
order and payment history, which is exactly what keeping customers is meant to prevent.
A duplicate is `409 CONFLICT` with `meta: { customerId, archived }` — the id is there so
an inline create sheet can offer the existing customer instead of leaving the merchant
stuck. Two different merchants may each have a customer on the same number.

Tags are trimmed and de-duplicated case-insensitively, so `VIP` and `vip ` do not both
exist.

### `PATCH /api/v1/customers/:id`

Every field editable, `null` clears an optional one.

**A customer's phone number is editable**, unlike the merchant's own verified sign-in
number: it was typed by the merchant, not verified by an OTP, and merchants mistype
numbers. Moving it onto a number another customer holds is `409` with that customer's id.

### `POST /api/v1/customers/:id/archive` · `…/restore`

Archiving hides a customer from lists and pickers. It never touches the orders and
payments that reference them: a historical document that lost its customer would be
unexplainable (PRD section 33).

### `GET /api/v1/customers/tags`

The distinct tags this merchant has used, for the filter row.

---

## Suppliers (merchant app)

Who the merchant buys from (PRD section 11). **Only the name is required** — a merchant
recording a purchase from the shop down the road often knows nothing else, and demanding
a phone number would only produce a fake one.

`GET /api/v1/suppliers` — `search`, `archived`, `outstanding`, `page`, `limit`, `sort`
`POST /api/v1/suppliers` · `GET /api/v1/suppliers/:id` · `PATCH /api/v1/suppliers/:id`
`POST /api/v1/suppliers/:id/archive` · `…/restore`

Names are unique per merchant. A phone number requires a country code alongside it, and
clearing the number clears the code with it — a dialling code on its own is not a contact
detail.

**SupplierView** carries `outstandingMinor` (what the merchant still owes them),
`purchaseCount`, `totalPurchasedMinor` and `lastPurchaseAt`. These are recomputed from
the supplier's purchases whenever one is created, cancelled or paid, rather than
incremented — they are figures a merchant reads at a glance, and a drift in them is
invisible until it is embarrassing.

**Archiving a supplier who is still owed money is refused** (`409`, with
`meta.outstanding`). An archived supplier leaves the pickers, and a merchant who owes
them money needs them findable.

---

## Purchases (merchant app)

What the merchant bought, from whom, and whether it has been paid for.

### `GET /api/v1/purchases`

`search`, `supplierId`, `subjectId`, `status`, `paymentStatus`, `overdue`, `received`,
`from`, `to`, `page`, `limit`, `sort`.

`subjectId` finds every purchase that touched one item or raw material, which is that
record's purchase history. `overdue` is the query described under **Payment state**.

**PurchaseView**

```json
{
  "id": "66f…",
  "reference": "PUR-0007",
  "supplierId": "66f…",
  "supplierName": "Deccan Wholesale",
  "lines": [
    {
      "subjectType": "material",
      "subjectId": "66f…",
      "name": "Wheat Flour",
      "unit": "kilogram",
      "quantity": 25,
      "unitCostMinor": 4200,
      "lineTotalMinor": 105000
    }
  ],
  "subtotalMinor": 105000,
  "additionalCostMinor": 15000,
  "totalMinor": 120000,
  "paidMinor": 50000,
  "outstandingMinor": 70000,
  "purchaseDate": "2026-09-01T00:00:00.000Z",
  "dueDate": "2026-09-15T00:00:00.000Z",
  "notes": null,
  "status": "recorded",
  "cancelledAt": null,
  "cancelledReason": null,
  "received": true,
  "receivedAt": "2026-09-01T00:00:00.000Z",
  "paymentStatus": "partially_paid",
  "paymentState": "overdue",
  "createdAt": "2026-09-01T00:00:00.000Z",
  "updatedAt": "2026-09-05T00:00:00.000Z"
}
```

`reference` is human-readable and unique per merchant. Numbers **restart at one for each
merchant**, because a merchant's first purchase is their number one regardless of how
many other businesses use the product. A failed write can leave a gap in the sequence;
that is the right trade, since re-using a number would put two purchases under one
reference and a merchant quoting it to a supplier would be pointing at the wrong thing.

Line `name` and `unit` are **snapshots** taken when the purchase was recorded, not joins.
Renaming or archiving an item later must not rewrite what the merchant bought last March.

### `POST /api/v1/purchases`

```json
{
  "supplierId": "66f…",
  "lines": [{ "subjectType": "material", "subjectId": "66f…", "quantity": 25, "unitCostMinor": 4200 }],
  "additionalCostMinor": 15000,
  "purchaseDate": "2026-09-01T00:00:00.000Z",
  "dueDate": "2026-09-15T00:00:00.000Z",
  "receiveStock": true
}
```

`subjectType` is `item` or `material`; a service cannot be bought. Quantities obey the
whole-number-unit rule. Two lines for the same record are `422`: that makes the received
quantity ambiguous, and one line with the full quantity is what was meant. A line against
an archived record, or a purchase from an archived supplier, is `409`.

`additionalCostMinor` is freight, loading, anything on the bill that is not a line.

**`receiveStock` (default `true`) takes the goods into stock as part of recording the
purchase.** The ledger entries and the purchase document are written in **one
transaction**: splitting them would allow a purchase that claims to be received next to
stock that never moved — a discrepancy a merchant cannot diagnose and the ledger cannot
explain.

### `POST /api/v1/purchases/:id/receive`

Takes the goods on an already-recorded purchase into stock. Separate from creation
because the two genuinely happen apart: the bill arrives when it arrives, and the van
when it does. Receiving twice is `409`.

Each line produces a `receipt` movement in the stock ledger, referencing the purchase.

### `PATCH /api/v1/purchases/:id`

`purchaseDate`, `dueDate` and `notes` only. **Lines, totals and the supplier are not
editable.** Changing them after stock has moved and payments have landed would mean
unwinding both; "cancel it and record it again" is a path a merchant can understand and
verify.

### `POST /api/v1/purchases/:id/cancel`

Two rules, both chosen so the outcome is predictable rather than convenient:

- **A purchase with payments against it cannot be cancelled** (`409`, with `meta.paid`).
  Cancelling would strand the money with nothing to belong to. Supplier returns and
  refunds are the right instrument and arrive in Phase 5.
- **If the received goods have since been sold, the reversal is refused** (`409`, with
  `meta: { available, unit }`) rather than clamping stock to zero and leaving a quantity
  the ledger cannot explain.

Otherwise the stock comes back as `reversal` movements — the receipt and its undoing are
both on the record, because a ledger you can delete from is not a ledger.

### `GET /api/v1/purchases/:id`

Returns `{ purchase, payments }`. A merchant opening a purchase wants to see what they
have paid, and a second round trip for three rows is not worth it.

### `GET /api/v1/purchases/summary`

`recorded`, `awaitingStock`, `unpaid`, `overdue`, `outstandingMinor`,
`spentThisMonthMinor` — for the dashboard's buying card.

---

## Payments (merchant app)

The payment engine, shared by every kind of payable. Purchases were its first consumer
and orders are its second — one engine, two adapters, no second definition of "partially
paid".

### `POST /api/v1/purchases/:id/payments`

```json
{ "amountMinor": 50000, "method": "bank_transfer", "reference": "NEFT-5521", "paidAt": "2026-09-05T00:00:00.000Z" }
```

`method` comes from `catalog/meta`: `cash`, `upi`, `card`, `bank_transfer`, `cheque`,
`other`. `201` returns `{ payment, purchase }`, so a caller need not refetch to show the
new outstanding amount.

**The entry and the parent's `paidMinor` are written in the same transaction**, so a
total can never exist that the entries cannot explain — the same guarantee the stock
ledger gives for quantities.

**An amount above the outstanding balance is refused**, not capped: `409` with
`meta: { outstanding, total, paid }`. A merchant who typed 50,000 instead of 5,000 needs
to be told, not quietly handed a receipt for a different number. A payment against a
fully paid or cancelled payable is also `409`.

A purchase supports as many payments as it takes; each keeps its own date, amount, method,
reference and notes (PRD section 9).

### `GET /api/v1/payments`

`payableType`, `payableId`, `method`, `direction`, `installmentNumber`, `from`, `to`,
`page`, `limit`, `sort`.

**PaymentEntryView**

```json
{
  "id": "66f…",
  "payableType": "purchase",
  "payableId": "66f…",
  "payableReference": "PUR-0007",
  "direction": "out",
  "amountMinor": 50000,
  "method": "bank_transfer",
  "reference": "NEFT-5521",
  "paidAt": "2026-09-05T00:00:00.000Z",
  "notes": null,
  "installmentNumber": null,
  "balanceAfterMinor": 70000,
  "actorType": "merchant",
  "actorLabel": "Anita Desai",
  "createdAt": "2026-09-05T00:00:00.000Z"
}
```

**Amounts are always positive**; `direction` says which way the money went (`out` to a
supplier, `in` from a customer). A total can never be made to disagree with the sum of
its entries by a stray sign.

`balanceAfterMinor` is what was still outstanding after this entry, so a payment row
reads on its own. `actorType` is `merchant` or `admin`, so a client can tell the merchant
when support recorded a payment on their behalf.

### `PATCH /api/v1/payments/:id`

```json
{ "reference": "CHQ-00012", "paidAt": "2026-10-02T00:00:00.000Z", "notes": "Cheque number was wrong" }
```

Corrects what an entry **says about itself**. `200` returns `{ payment }`.

**Sending `amountMinor` or `method` is `422`**, not ignored: a client that sends one has
misunderstood something, and silently dropping it would let them believe the correction had
been applied.

An explicit `null` clears `reference` or `notes`. A corrected `paidAt` moves the payment into
a different period, which the dashboard and the `from`/`to` filters count over — that is the
point of being able to correct it.

Every correction is audited as `payment.annotated`, and the summary says the amount was not
changed, so the trail cannot be mistaken for one.

**Payment entries are append-only where money is concerned.** The amount, the method, the
payable, the direction, the balance it left behind and who recorded it can never change —
a total has to stay explainable by the sum of its entries, and a history whose amounts can be
rewritten is not a history. The guard is on the model, not only the route, so a future caller
that bypassed the route is still stopped.

What an entry says about itself is not money: a mistyped cheque number, a note, or the date
the money actually changed hands. Guarding those as well would leave a merchant with a
permanently wrong reference and no way to fix it, which is a worse record rather than a safer
one. A wrong **amount** is still corrected by a further entry, and refunds and credits arrive
with returns in Phase 5.

---

## Orders (merchant app)

The sale itself: items, services or both, for a named customer or for nobody.

### `POST /api/v1/orders`

```json
{
  "customerId": "66f…",
  "lines": [
    { "lineType": "item", "subjectId": "66f…", "quantity": 2 },
    { "lineType": "service", "subjectId": "66f…", "quantity": 1, "durationMinutes": 90 }
  ],
  "discountType": "percent",
  "discountPercent": 10,
  "taxPercent": 18,
  "status": "confirmed",
  "orderDate": "2026-10-05T00:00:00.000Z",
  "dueDate": "2026-10-19T00:00:00.000Z",
  "notes": "Deliver after 6pm"
}
```

`customerId` may be omitted or `null`: **an anonymous counter sale is a first-class case**
(PRD section 8), and the receivables screen names it "Walk-in sale" rather than leaving a
blank cell. `status` defaults to `confirmed` and may be `draft` for a held order or quote;
an order **cannot be created as `cancelled` or `returned`**.

`unitRateMinor` on a line overrides the catalog price for that sale only. Omitted, the
item's selling price or the service's rate is used. `durationMinutes` is kept only for
time-based billing units (`hourly`, `per_minute`, …) and ignored elsewhere.

`201` returns `{ order }`.

**Names, units and rates are copied onto the line at write time**, never joined at read
time. Repricing an item next week must not change what a customer was charged last
Tuesday.

**Totals are built once and stored.** The order of operations is: price the lines, sum
them, subtract the discount, then **apply tax to the discounted subtotal**. That is the
order a merchant can check by hand. A discount larger than the order is `422`, not
silently capped.

**The order and the stock it commits are written in one transaction.** A sale that claims
to have happened next to stock that never moved is the discrepancy a merchant cannot
diagnose and the ledger cannot explain.

**Selling more than there is in stock is `409`** with `meta: { available, unit }`; nothing
is left behind. Services never touch stock, and an item with `trackStock: false` is skipped
rather than refused.

The same record twice on one order is `422` — change its quantity instead.

### `GET /api/v1/orders`

`search` (reference, customer name, line name), `customerId`, `subjectId` (what was sold),
`status`, `paymentStatus`, `overdue`, `open`, `from`, `to`, `page`, `limit`,
`sort` (`orderDate`, `createdAt`, `totalMinor`, `dueDate`).

`open=true` is "still to be worked on": not completed, not cancelled, not returned.
`overdue=true` is an **indexed query, not a stored flag** — see below.

### `GET /api/v1/orders/:id`

Returns `{ order, payments, allowedTransitions }`. The payment timeline comes with the
order because that is what a merchant opening one wants, and `allowedTransitions` is the
lifecycle map for this order's current status, so **no client keeps its own copy of the
rules**.

### `GET /api/v1/orders/:id/activity`

`limit` (default 50, max 100). What has happened to this order, newest first, read from the
same audit trail the admin panel reads.

```json
{
  "activity": [
    {
      "id": "66f…",
      "action": "payment.recorded",
      "summary": "Recorded INR 50.00 against order ORD-0007 by cash; INR 40.00 outstanding.",
      "actorType": "admin",
      "actorLabel": "Support Team",
      "changes": [{ "field": "paidMinor", "from": 0, "to": 5000 }],
      "at": "2026-10-05T09:00:00.000Z"
    }
  ]
}
```

**`actorType` is the point.** When support records a payment or moves an order on, the
merchant sees who did it rather than finding an unexplained change (PRD section 36).

`ip` and `requestId` are deliberately **not** served here. They are operational detail for
the admin audit screen; a request id in a merchant's timeline invites support questions
rather than answering them.

Scoped by loading the order as the merchant first — audit entries are keyed by target rather
than by merchant, so the ownership check *is* the scope. Another merchant's order is `404`.

### `PATCH /api/v1/orders/:id`

**Only a draft may have its lines or totals changed** — `409` with `meta: { status }`
otherwise. Once stock has moved and payments may have landed, the lines are history;
"cancel it and write a new one" is a path a merchant can understand and verify. Notes, the
due date, the order date and the customer stay editable throughout.

Repricing a draft **clears any instalment plan**, because a plan built against the old
total no longer adds up.

### `POST /api/v1/orders/:id/status`

```json
{ "status": "completed", "reason": null }
```

**The lifecycle, in one place** (`src/config/orders.ts`):

| From | May become |
| --- | --- |
| `draft` | `confirmed`, `in_progress`, `ready`, `completed`, `cancelled` |
| `confirmed` | `in_progress`, `ready`, `completed`, `cancelled` |
| `in_progress` | `ready`, `completed`, `cancelled` |
| `ready` | `completed`, `cancelled` |
| `completed` | `returned` |
| `cancelled` | — |
| `returned` | — |

A transition that is not listed is `409` with `meta: { from, to, allowed }`. Moving to the
status an order is already in is also `409`. An order never goes backwards into a draft.

**One rule decides stock:** `confirmed`, `in_progress`, `ready` and `completed` hold the
goods; `draft` holds nothing and `cancelled`/`returned` have given them back. So
confirming a draft commits stock once, the steps between change nothing, and cancelling or
returning writes a reversal or a return movement into the ledger. `stockCommitted` and
`stockCommittedAt` on the order say where it stands.

**Cancelling an order that has taken money is `409`** with `meta: { paid }`. The money
would be stranded with nothing to belong to; refunds are the right instrument and arrive
in Phase 5.

### `POST /api/v1/orders/:id/payments`

```json
{ "amountMinor": 10000, "method": "upi", "installmentNumber": 2, "reference": "UPI-8891" }
```

The shared payment engine, with `direction: "in"`. `201` returns `{ payment, order }`.
Overpayment is refused with `meta: { outstanding, total, paid }`, exactly as for a
purchase. `installmentNumber` is optional — see allocation below.

**OrderView**

```json
{
  "id": "66f…",
  "reference": "ORD-0001",
  "customerId": "66f…",
  "customerName": "Kavita Joshi",
  "lines": [
    {
      "lineType": "item",
      "subjectId": "66f…",
      "name": "Masala Chai Packet",
      "unit": "piece",
      "billingUnit": null,
      "quantity": 2,
      "unitRateMinor": 4500,
      "durationMinutes": null,
      "lineTotalMinor": 9000
    }
  ],
  "subtotalMinor": 9000,
  "discountType": "none",
  "discountPercent": null,
  "discountMinor": 0,
  "taxPercent": null,
  "taxMinor": 0,
  "totalMinor": 9000,
  "paidMinor": 0,
  "outstandingMinor": 9000,
  "status": "confirmed",
  "stockCommitted": true,
  "stockCommittedAt": "2026-10-05T09:00:00.000Z",
  "orderDate": "2026-10-05T09:00:00.000Z",
  "dueDate": null,
  "completedAt": null,
  "cancelledAt": null,
  "cancelledReason": null,
  "returnedAt": null,
  "returnedReason": null,
  "notes": null,
  "paymentStatus": "unpaid",
  "paymentState": "unpaid",
  "installments": [],
  "nextDueInstallment": null,
  "createdAt": "2026-10-05T09:00:00.000Z",
  "updatedAt": "2026-10-05T09:00:00.000Z"
}
```

`paymentStatus` is the **stored** state and has only three values: `unpaid`,
`partially_paid`, `fully_paid`. `paymentState` is what a client displays: the same thing
with the clock folded in, so an unpaid order past its due date reads as `overdue` **without
anything having been written to the row**. A fully paid order is never overdue, however
long ago its date was, and neither is a closed one.

**Overdue is never stored.** A stored flag needs a nightly job to maintain, and any row
the job had not reached would be wrong. Filtering is an indexed query on
`{ paymentStatus, dueDate }`.

---

## Instalments (merchant app)

A plan is set wholesale rather than patched row by row, because a schedule has to add up to
the order total and that can only be checked against the whole of it.

### `PUT /api/v1/orders/:id/installments`

```json
{
  "installments": [
    { "amountMinor": 15000, "dueDate": "2026-10-12T00:00:00.000Z", "notes": "On delivery" },
    { "amountMinor": 15000, "dueDate": "2026-11-11T00:00:00.000Z" }
  ]
}
```

### `POST /api/v1/orders/:id/installments/even`

```json
{ "count": 3, "firstDueDate": "2026-10-12T00:00:00.000Z", "everyDays": 30 }
```

Both return `{ order }` with the plan on it. Up to 36 instalments.

**The plan must add up to the order total exactly** — `422` naming whether it is over or
under. The whole point of a schedule is that paying all of it settles the order; a plan
short by a rupee leaves a balance nobody can explain.

**An even split puts the remainder on the first instalment**, so the last payment is the
round number a merchant agreed. ₹1,000.00 over three is `[33334, 33333, 33333]`.

**Dates must not run backwards** (`422` naming the instalment), or "next due" means
nothing. The **order's own `dueDate` follows the last instalment**, so a plan and a due
date can never say different things about when the money is expected.

**A plan may be added to an order that has already taken money** — a deposit first, terms
agreed afterwards. What has been paid is spread across the new plan from the earliest
instalment, because the plan is a projection of the payments. **Replacing a plan that
already has payments allocated against it is `409`** with `meta: { paid }`: the entries
would point at instalments that no longer exist.

A plan on a closed order is `409`.

**InstallmentView**

```json
{
  "number": 1,
  "amountMinor": 15000,
  "paidMinor": 15000,
  "outstandingMinor": 0,
  "dueDate": "2026-10-12T00:00:00.000Z",
  "status": "paid",
  "isOverdue": false,
  "isNextDue": false,
  "notes": "On delivery",
  "reminderSentAt": null
}
```

`status` is `pending`, `partially_paid` or `paid`. `isOverdue` is derived from the date at
read time, like everything else about lateness. `isNextDue` marks the one the PRD asks to
be made obvious (section 9), and `nextDueInstallment` on the order repeats it so a client
need not search.

**Allocation.** A payment naming an `installmentNumber` goes there, and `422` if that
number is not on the plan. A payment naming none **fills the earliest unpaid instalments
in order**, which is what a merchant handing over cash means by "put this towards what I
owe". Anything left over after a named instalment still counts towards the order's own
total — no money is lost, it simply is not attributed to a schedule row.

---

## Receivables and the dashboard (merchant app)

### `GET /api/v1/receivables`

`overdue`, `page`, `limit`. **Grouped by customer, worst first** — overdue by amount, then
due soonest. A merchant chasing money thinks in people: "who owes me, and who is late"
(PRD section 9).

```json
{
  "customerId": "66f…",
  "customerName": "Fatima Sheikh",
  "orderCount": 2,
  "outstandingMinor": 24750,
  "overdueMinor": 4750,
  "nextDueDate": "2026-09-23T00:00:00.000Z",
  "isOverdue": true
}
```

Anonymous sales group under a `null` customer, named "Walk-in sale", since there is nobody
to chase.

### `GET /api/v1/receivables/installments`

`overdue`, `withinDays`, `limit`. Unpaid instalments soonest first, each carrying its
order's reference and customer. This is what the receivables schedule shows and what Phase
5's reminders will be checked against.

### `GET /api/v1/dashboard`

```json
{
  "summary": {
    "sales": {
      "todayMinor": 15000,
      "todayOrders": 2,
      "thisMonthMinor": 15000,
      "thisMonthOrders": 2,
      "openOrders": 4,
      "draftOrders": 1
    },
    "receivables": {
      "outstandingMinor": 156350,
      "overdueMinor": 4750,
      "overdueOrders": 1,
      "dueSoonMinor": 0,
      "dueSoonOrders": 0,
      "customersOwing": 2
    },
    "collectedTodayMinor": 80800,
    "payablesMinor": 121000
  }
}
```

**Every figure is counted from the merchant's own records by an indexed aggregation**,
never estimated. A dashboard that invents a number is worse than one that shows none
(PRD section 6.1). The sales and receivables figures come from a single `$facet`, because
this is the first screen a merchant sees every morning.

`collectedTodayMinor` is money that came **in** today, which is deliberately not the same
as what was sold today. `payablesMinor` is what is still owed to suppliers. "Due soon" is a
seven-day window (`DUE_SOON_DAYS`).

A merchant with no history gets zeros, not an empty object.

### Order and payment preferences

Carried on the business profile (`GET`/`PATCH /api/v1/business`), because they are settings
about how this business trades rather than about one order:

```json
{
  "preferences": {
    "paymentMethods": ["cash", "upi"],
    "defaultOrderStatus": "confirmed",
    "defaultTaxPercent": 18
  }
}
```

Written with `enabledPaymentMethods`, `defaultOrderStatus` and `defaultTaxPercent`.

**`paymentMethods` is always the resolved list**, never what is stored: an empty stored list
means "all of them", and a client should not have to know that. A merchant who has never
opened the setting is therefore never left unable to take a payment.

**The list is a subset of the methods the server understands**, validated against them —
`422` for anything else. The engine stores the method on every entry, and a label it had
never heard of could not be rendered, filtered or reported on. Turning a method off later
never invalidates an entry already written with it.

`defaultOrderStatus` may only be `draft` or `confirmed`: the rest of the lifecycle is reached
by moving an order on, not by starting there. `defaultTaxPercent` is prefilled on a new
order; an explicit `null` clears it, and `0` is a rate rather than an absence.

### Order vocabulary on `GET /api/v1/catalog/meta`

Phase 4 adds, alongside the existing lists:

```json
{
  "orderStatuses": [
    { "value": "draft", "allowedNext": ["confirmed", "…"], "holdsStock": false, "editable": true, "terminal": false }
  ],
  "orderLineTypes": ["item", "service"],
  "discountTypes": ["none", "amount", "percent"],
  "installmentStatuses": ["pending", "partially_paid", "paid"],
  "limits": { "maxInstallments": 36, "maxOrderLines": 200 }
}
```

A client that knows which transitions are legal can grey out the rest instead of offering
a button the server will refuse — and it learns the rules from the server rather than
keeping a second copy of the map.

---

## Admin panel

### `POST /api/v1/admin/auth/login`

Request: `{ "email": "admin@sellersdash.local", "password": "…" }`

`200`:

```json
{
  "success": true,
  "data": {
    "admin": {
      "id": "66f…",
      "name": "Super Admin",
      "email": "admin@sellersdash.local",
      "status": "active",
      "lastLoginAt": "2026-10-01T12:00:00.000Z",
      "role": { "id": "66f…", "slug": "super_admin", "name": "Super administrator", "description": "…" },
      "permissions": ["merchant.view", "merchant.edit", "…"]
    },
    "tokens": { }
  }
}
```

Wrong password, unknown email and suspended account all return the same `401` message. `permissions` drives the admin UI; the server enforces the same list independently.

### `POST /api/v1/admin/auth/refresh` · `GET /api/v1/admin/auth/me` · `POST /api/v1/admin/auth/logout`

As with the merchant equivalents.

### `GET /api/v1/admin/merchants` — `merchant.view`

Query: `search` (name or phone), `status`, `gender`, `page`, `limit` (max 100), `sort` (`createdAt`, `updatedAt`, `firstName`, `lastName`, `lastLoginAt`, prefix `-` to reverse).

Returns a paginated list of `MerchantView`. Search terms are treated as literal text; unknown sort fields fall back to `-createdAt`.

### `GET /api/v1/admin/merchants/:id` — `merchant.view`

### `PATCH /api/v1/admin/merchants/:id` — `merchant.edit`

Editable: `firstName`, `lastName`, `gender`. The verified phone number is rejected here too.

### `PATCH /api/v1/admin/merchants/:id/status` — `merchant.suspend`

Request: `{ "status": "suspended", "reason": "optional, 3–300 chars" }`

Suspending revokes every active session for that merchant immediately, so a signed-in device stops working at once.

### Roles — `role.view` to read, `role.manage` to change

| Endpoint | Permission |
|---|---|
| `GET /admin/roles` | `role.view` |
| `POST /admin/roles` | `role.manage` |
| `PATCH /admin/roles/:id` | `role.manage` |
| `DELETE /admin/roles/:id` | `role.manage` |

`GET` returns `{ "data": { "roles": [ … ], "permissionGroups": [ { "group": "Merchants", "permissions": [ … ] } ] } }`.

Each role carries `memberCount` (how many admins hold it) along with `editable` and
`deletable`, so a client never has to infer which controls to offer:

```json
{ "id": "…", "slug": "finance_admin", "name": "Finance / payment operations",
  "description": "…", "permissions": ["order.view", "payment.manage"],
  "isSystem": true, "memberCount": 1, "editable": true, "deletable": false,
  "createdAt": "…", "updatedAt": "…" }
```

`POST` takes `{ name, description, permissions[] }` and returns `201`. The slug is derived
from the name, is made unique, and never changes afterwards. `PATCH` accepts any of the
same three fields.

Two rules keep the panel from being locked shut by its own permission editor, and both are
enforced here rather than in any client:

- **The seeded `super_admin` role is fixed.** `PATCH` and `DELETE` both return `403`. It is
  the recovery path if another role is left unable to manage admins or permissions.
- **Nothing may leave the platform without a keyholder** — an active admin whose role holds
  both `admin.manage` and `role.manage`. A `PATCH` that would revoke the last one, or a
  `DELETE` of the last such role, returns `409 CONFLICT`.

`DELETE` also returns `403` for any seeded role, and `409` with
`meta.memberCount` when admins still hold the role. Permissions outside the catalogue are
rejected with `422`.

### Admin team — `admin.view` to read, `admin.manage` to change

| Endpoint | Permission |
|---|---|
| `GET /admin/admins` | `admin.view` |
| `GET /admin/admins/:id` | `admin.view` |
| `POST /admin/admins` | `admin.manage` |
| `PATCH /admin/admins/:id` | `admin.manage` |
| `PATCH /admin/admins/:id/status` | `admin.manage` |
| `POST /admin/admins/:id/reset-password` | `admin.manage` |

List query: `search` (name or email), `status`, `roleId`, `page`, `limit`, `sort`
(`createdAt`, `updatedAt`, `name`, `email`, `lastLoginAt`).

`POST` takes `{ name, email, roleId, password }` and returns `201`. The account is created
with `mustChangePassword: true` — see below. `PATCH` accepts `name`, `email` and `roleId`.
`PATCH …/status` takes `{ status: "active" | "suspended", reason? }`.

**Accounts are never deleted.** There is no `DELETE`: an admin who leaves is suspended,
which revokes every session at once and keeps the audit trail pointing at a real account.

Guards, all returning `403`:

- You cannot suspend your own account, change your own role, or reset your own password
  here. One mistake must not remove the access needed to undo it. (Changing your own
  password is a different endpoint, below.)
- You cannot suspend or demote the last active keyholder — `409 CONFLICT`.

### `PATCH /api/v1/admin/auth/me` — any signed-in admin

Takes `{ name }` and returns the updated profile. Only the display name: the email address
is the sign-in identity and the role decides what the account reaches, so both are changed
by someone else through `PATCH /admin/admins/:id`. Any other field in the body is ignored.

Recorded as `admin.profile_updated`. The audit trail stores the actor's name as text at the
time of writing, so a rename never rewrites what is already recorded.

### `POST /api/v1/admin/auth/change-password` — any signed-in admin

Takes `{ currentPassword, newPassword }`. Passwords must be at least 12 characters with an
upper-case letter, a lower-case letter and a number; reusing the current one is rejected.

Succeeding revokes every **other** session for the account — the calling session survives,
so an admin is not signed out of the tab they are working in.

### Passwords set by somebody else

There is no mail service, so a new admin's first password is chosen by whoever creates
them. That password is a way in, not a credential: creation and `reset-password` both set
`mustChangePassword: true`, and while it is set **every admin endpoint returns `403` with
`PASSWORD_CHANGE_REQUIRED`** except `GET /admin/auth/me`, `POST /admin/auth/logout` and
`POST /admin/auth/change-password`.

`mustChangePassword` is on the admin object returned by login and by `/admin/auth/me`, so a
client can show the change screen rather than discovering the state through a 403.

### `GET /api/v1/admin/audit-logs` — `audit.view`

Query: `targetType`, `targetId`, `actorType` (`merchant` \| `admin` \| `system`), `actorId`,
`action`, `page`, `limit`.

`actorId` narrows to what one account *did*; `targetId` narrows to what was done *to* a
record. Both are indexed.

Entries carry `actorLabel`, `action`, `summary` and a `changes` array of `{ field, from, to }`.

### Phase 2 — business and catalog

`GET /api/v1/admin/catalog/meta` — any signed-in admin; the same vocabulary the app reads.

| Endpoint | Permission |
|---|---|
| `GET /admin/merchants/:merchantId/business` | `business.view` |
| `PATCH /admin/merchants/:merchantId/business` | `business.edit` |
| `GET /admin/merchants/:merchantId/catalog-summary` | `merchant.view` |
| `GET /admin/merchants/:merchantId/categories` | `item.view` |
| `GET /admin/items` | `item.view` |
| `PATCH /admin/items/:id` · `…/archive` · `…/restore` | `item.manage` |
| `GET /admin/services` | `service.view` |
| `PATCH /admin/services/:id` · `…/archive` · `…/restore` | `service.manage` |
| `GET /admin/materials` | `material.view` |
| `PATCH /admin/materials/:id` · `…/archive` · `…/restore` | `material.manage` |
| `GET /admin/stock-movements` | `stock.view` |
| `GET /admin/low-stock` | `stock.view` |
| `POST /admin/stock/:subjectType/:subjectId/adjust` | `stock.adjust` |

The catalog lists span every merchant and take an optional `merchantId` to drill into
one. They accept the same `search`, `archived`, `lowStock`, `page`, `limit` and `sort`
parameters as the merchant endpoints, and each row carries `merchantId` and
`merchantName` so a cross-merchant list is readable.

An admin adjusting stock goes through **the same ledger service** as the merchant app,
with `actorType: "admin"` on the movement. There is no administrative shortcut that
writes a quantity: an admin correcting a figure leaves the same explainable trail a
merchant does, and the merchant can see who changed it.

### Phase 3 — customers, suppliers and purchases

| Endpoint | Permission |
|---|---|
| `GET /admin/customers` · `GET /admin/customers/:id` | `customer.view` |
| `PATCH /admin/customers/:id` | `customer.edit` |
| `POST /admin/customers/:id/archive` · `…/restore` | `customer.archive` |
| `GET /admin/suppliers` · `GET /admin/suppliers/:id` | `supplier.view` |
| `PATCH /admin/suppliers/:id` · `…/archive` · `…/restore` | `supplier.manage` |
| `GET /admin/purchases` · `GET /admin/purchases/:id` | `purchase.view` |
| `POST /admin/purchases/:id/cancel` | `purchase.manage` |
| `POST /admin/purchases/:id/payments` | `payment.manage` |
| `GET /admin/payments` | `payment.view` |
| `GET /admin/merchants/:merchantId/relationship-summary` | `merchant.view` |
| `GET /admin/orders` · `GET /admin/orders/:id` | `order.view` |
| `POST /admin/orders/:id/status` | `order.edit` |
| `POST /admin/orders/:id/cancel` | `order.cancel` |
| `POST /admin/orders/:id/payments` | `payment.manage` |
| `PUT /admin/orders/:id/installments` | `installment.manage` |
| `GET /admin/installments` | `installment.view` |
| `GET /admin/receivables` | `payment.view` |
| `GET /admin/merchants/:merchantId/order-summary` | `order.view` |
| `PATCH /admin/payments/:id` | `payment.manage` |

The lists span every merchant and take an optional `merchantId` to drill into one. Each
row carries `merchantId` and `merchantName` so a cross-merchant list is readable.

An administrator cancelling a purchase, moving an order on or recording a payment goes
through **the same services as the merchant app** — the same transaction, the same guards,
the same lifecycle map, the same ledger — with `actorType: "admin"` on the entry and the
audit record. There is no administrative shortcut: support correcting something leaves the
same explainable trail a merchant does, the merchant can see who did it, and an
administrator cannot reach a state a merchant could not.

**Cancelling an order has its own endpoint rather than a gate that reads the request
body**, because `order.cancel` is a separate permission and a check that depends on the
body is a check that can be forgotten on the next endpoint. `POST /admin/orders/:id/status`
refuses `cancelled` with `422`.

`GET /admin/receivables` rolls up **per merchant**, worst first: that is the unit an
administrator acts on, since a merchant whose receivables are slipping is the one support
calls. Drilling into one merchant's own customers is the merchant-side
`GET /receivables`.

`GET /admin/orders` and `GET /admin/payments` both take `from` and `to`. The payments filter
is on `paidAt` — when the money moved — not on when the row was written, so a back-dated
payment belongs to the period it was made in.

`PATCH /admin/payments/:id` is the same engine call the merchant's own endpoint uses, so the
same fields are immutable for both: **an administrator cannot change an amount either**, and
the audit entry names them.

---

## Operational endpoints

- `GET /health` — liveness. Always `200` while the process is serving.
- `GET /ready` — readiness. `503` when the database is not connected.
- `GET /uploads/*` — stored merchant media, served with `nosniff` and a restrictive CSP.

---

## Permissions in use

**Phase 1** — `merchant.view`, `merchant.edit`, `merchant.suspend`, `role.view`, `audit.view`.

**Phase 2** — `business.view`, `business.edit`, `item.view`, `item.manage`,
`service.view`, `service.manage`, `material.view`, `material.manage`, `stock.view`,
`stock.adjust`.

**Phase 3** — `customer.view`, `customer.create`, `customer.edit`, `customer.archive`,
`supplier.view`, `supplier.manage`, `purchase.view`, `purchase.manage`, `payment.view`,
`payment.manage`.

**Phase 4** — `order.view`, `order.edit`, `order.cancel`, `installment.view`,
`installment.manage` (`order.create` is the merchant's own path and has no admin
endpoint: support does not write orders on a merchant's behalf).

The full catalogue is seeded (`src/config/permissions.ts`) so later phases add endpoints
rather than reworking RBAC. Seeded roles: Super administrator, Operations administrator,
Support / merchant operations, Finance / payment operations, Read-only. The audit trail
records admin actions, so `audit.view` sits with the administrative roles rather than
with general read access.

Every permission is enforced on the server. The admin panel hides what a role cannot
use, but hiding a control is a courtesy, not the check — the API refuses the request
regardless of what the UI offered.
