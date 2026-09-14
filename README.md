# KJ STORE

KJ STORE is a Windows desktop inventory and point-of-sale application built with Electron.

## Run it

```powershell
npm.cmd install
npm.cmd start
```

Run its automated checks with:

```powershell
npm.cmd test
```

## How it is organized

- `src/main.js` creates the Electron window, holds the signed-in session in memory, and registers app actions. It is also where every action is authorized before it reaches the data layer.
- `src/preload.js` exposes only approved actions to the visible interface.
- `src/store.js` is the local data layer. It validates products and users, hashes passwords, and commits a completed sale plus its stock deduction together.
- `src/renderer/` contains the desktop user interface: Login, Dashboard, Record Sale, Inventory, History, and User Management.
- `test/store.test.js` verifies the important inventory, sales, and account rules.

## Accounts and roles

KJ STORE requires signing in before any page is usable. On first run it creates one **Super Admin** account and nothing else — no sample products or sales:

- Username: `admin`
- Password: `Admin123!`

**Sign in and change this password immediately** from User Management, or create a personal Super Admin account and deactivate the default one.

Two roles are supported:

- **Super Admin** — everything, plus User Management (create/edit accounts, activate or deactivate, reset passwords, assign roles).
- **Regular User** — Dashboard, Record Sale, Inventory, and History. No access to User Management, enforced on the backend, not just hidden in the sidebar.

KJ STORE always keeps at least one active Super Admin account; the app refuses to demote or deactivate the last one.

Signing in is remembered across app restarts until you log out.

## Data

KJ STORE stores its local data in Electron's per-user application-data directory as `kj-store-data.json`. On a new, empty installation it creates the default Super Admin account and nothing else — add the store's real products from **Inventory**.

When a product is archived, it is removed from inventory and point-of-sale selection, but sale records retain a snapshot of its name, price, quantity, and subtotal.

Every completed sale also records the account that processed it. History and transaction details show who processed each sale ("Processed By"); Super Admins can additionally filter the Dashboard by user. Sales recorded before this feature existed have no associated user and display as "Unknown user" rather than being reassigned.

## Correcting a mistaken sale

Completed sales are never edited or deleted — that would silently corrupt stock levels, change past reports after the fact, and erase the record of what actually happened. Instead, a **Super Admin** can **void** a sale from History:

- The sale stays visible in History, marked **Voided**, along with who voided it, when, and the reason given.
- The stock it deducted is automatically restored.
- It's excluded from Dashboard totals and Sales Reports going forward.
- A voided sale cannot be voided again.

## Performance with large amounts of data

The database is one JSON file, fully read and rewritten on every operation. That cost scales with the *total* size of the file, not with how much a given screen actually needs — so as sales history grows into the tens of thousands of records, two things help:

**History now defaults to this week** (Monday through today), not "every sale ever." Widen the date range or check "Include archived sales" to search further back. This mainly reduces how much data is cloned and rendered per visit; it doesn't shrink the underlying file by itself.

**Archiving** (Super Admin, from the History page) is what actually shrinks the file. It moves sales older than a chosen cutoff date out of the active database and into separate `kj-store-data-archive-<year>.json` files, one per calendar year, sitting next to the main data file. Nothing is deleted:

- Archived sales still show up in History, transaction detail, receipts, and reports — they're just stored elsewhere.
- Day-to-day use (Dashboard, "this week," Record Sale, current Inventory) never reads archive files at all, since it only ever needs recent data.
- A search or report that explicitly reaches into an archived year opens only that year's file, not the entire archive.

Voiding an archived sale still works and correctly restores stock.

## Units of measurement

Each product is stocked and sold in exactly one unit, chosen when you add it: piece, pack, box, sack, kilogram, gram, liter, or milliliter.

- **Whole units** (piece, pack, box, sack) — stock and sale quantities are always whole numbers.
- **Divisible units** (kg, g, liter, mL) — stock and sale quantities may be decimals, so a customer can buy less than a full unit (e.g. 2 kg of rice).

There is no per-sale unit conversion. A product bought in bulk (e.g. a 50kg sack of rice) should be tracked in the smaller unit you actually sell it in — set its unit to **kg** and restock by entering the sack's total weight (`+50`), rather than tracking it in sacks and converting on every sale. This keeps every sale's math exact and avoids rounding drift. The product form shows a hint for this whenever you pick a divisible unit.
