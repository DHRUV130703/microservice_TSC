# Prompt: Build Node.js Microservice & API for Pincode-Based Business Metrics

I need you to build a production-ready **Node.js microservice and API** that extracts business metrics from **Google BigQuery based on a user-provided pincode**.

## 1. Problem Statement

We need a backend microservice where the user enters a **pincode**, and the service searches/query data across the relevant BigQuery tables to calculate the following metrics for that pincode over the **last 6 months**:

1. **Average Order Value (AOV)**
2. **Conversion Rate**

The frontend will provide the pincode as input and consume the API response to display these metrics.

The high-level flow should be:

```text
User enters Pincode
        ↓
Frontend
        ↓
Node.js API / Microservice
        ↓
Identify/query relevant BigQuery tables
        ↓
Filter data for Pincode + Last 6 Months
        ↓
Calculate Metrics
        ↓
Return JSON Response
        ↓
Frontend displays AOV + Conversion Rate
```

---

# 2. Important: Inspect Existing Files First

Before writing the implementation:

### A. Inspect the project/repository structure

Understand what already exists before creating new files.

### B. Locate the service-account credentials

The **Google Cloud / BigQuery service-account information is already provided in the project/folder**.

Do NOT ask me to provide credentials again.

Find the existing service-account configuration and determine:

* Project ID
* Service account email
* BigQuery permissions
* Dataset/project access
* Existing configuration/environment variables
* Any existing Google Cloud or BigQuery integration

### C. Inspect the BigQuery structure

This is extremely important.

Do not assume the table names, dataset names, column names, or schemas.

You need to inspect the available BigQuery datasets/tables and determine:

* Which tables contain order data
* Which tables contain lead/customer data
* Which tables contain conversion-related information
* Which column represents pincode
* Which column represents order date
* Which column represents order value/revenue
* Which columns can be used to identify leads/orders/conversions
* Whether multiple tables need to be joined
* Whether historical data is distributed across multiple tables
* Whether tables are partitioned by date
* Whether there are duplicate records
* Whether there are different schemas across tables

If there are multiple tables containing relevant historical data, the service should correctly query/join/union the required tables.

**Do not hardcode assumptions without validating them against the actual BigQuery schema.**

---

# 3. Metrics Required

## Metric 1 — Average Order Value

For the requested pincode, calculate the Average Order Value for the last 6 months.

Conceptually:

```text
AOV = Total Order Value / Number of Orders
```

The implementation must determine from the actual BigQuery schema:

* What constitutes a valid order
* Which amount/revenue field should be used
* Which order statuses should be included/excluded
* Which date should be used for the 6-month filter
* How cancelled/refunded/failed orders should be treated

Do not make assumptions if the database contains explicit status fields.

---

# 4. Metric 2 — Conversion Rate

Calculate the conversion rate for the requested pincode for the last 6 months.

Conceptually:

```text
Conversion Rate = Converted Leads / Total Eligible Leads × 100
```

However, **do not assume the exact definition of conversion**.

Inspect the available BigQuery tables and determine the appropriate business fields/statuses that represent:

* Total eligible leads
* Converted leads
* Order/booking conversion

Document the exact definition used in the implementation.

If conversion requires joining lead/customer/order tables, implement the correct join using the available identifiers.

Examples of possible identifiers include:

* Lead ID
* Customer ID
* Phone number
* Order ID
* Booking ID

Use the most reliable identifier available in the data.

---

# 5. Date Range

The API should dynamically calculate:

```text
Last 6 Months
```

from the current date/time.

Do NOT hardcode dates.

For example, if the API is called on:

```text
2026-08-31
```

the query should dynamically calculate the appropriate six-month period.

Use BigQuery date functions where appropriate so the filtering happens efficiently at the database level.

---

# 6. Pincode Input

The API should accept a pincode as input.

Example:

```http
GET /api/v1/metrics?pincode=400092
```

or, preferably if you determine POST is more appropriate:

```http
POST /api/v1/metrics
```

Request:

```json
{
  "pincode": "400092"
}
```

Validate:

* Pincode is mandatory
* Pincode should contain valid characters
* Handle invalid/unknown pincodes gracefully
* Handle pincodes for which no data exists

Do not unnecessarily restrict the implementation to a specific Indian pincode length unless the underlying business requirement requires it.

---

# 7. API Response

The API should return a clean and frontend-friendly response.

Example:

```json
{
  "success": true,
  "data": {
    "pincode": "400092",
    "period": {
      "from": "2026-03-01",
      "to": "2026-08-31"
    },
    "metrics": {
      "averageOrderValue": 18500,
      "conversionRate": 12.45
    }
  }
}
```

You may improve the response structure if you believe there is a better production-grade design.

Also consider returning supporting values where useful, for example:

```json
{
  "totalOrders": 125,
  "totalOrderValue": 2312500,
  "totalLeads": 1004,
  "convertedLeads": 125
}
```

These values will make the metrics easier to validate and debug.

---

# 8. BigQuery Query Architecture

The microservice should be designed properly rather than putting all SQL directly inside the API controller.

Recommended architecture:

```text
API Route
   ↓
Controller
   ↓
Metrics Service
   ↓
BigQuery Repository / Query Layer
   ↓
BigQuery
```

Separate:

### Controller

Responsible for:

* Request validation
* Calling the metrics service
* Returning HTTP responses

### Metrics Service

Responsible for:

* Business logic
* Metric calculation/orchestration
* Date range calculation
* Handling the pincode

### BigQuery Repository

Responsible for:

* BigQuery queries
* Dataset/table interaction
* Query parameters
* Returning raw data/results

This should make the code maintainable and testable.

---

# 9. BigQuery Efficiency

The service should be optimized for BigQuery.

Important requirements:

* Do not retrieve entire tables into Node.js
* Perform filtering inside BigQuery
* Filter by pincode at query level
* Filter by date at query level
* Select only required columns
* Avoid `SELECT *`
* Use parameterized queries
* Avoid unnecessary full-table scans
* Take advantage of partitioned tables if available
* Use appropriate joins
* Avoid querying the same data repeatedly if one optimized query can provide the metrics

If the relevant data exists across multiple tables, design the query efficiently.

If multiple independent queries are genuinely required, execute them efficiently, potentially in parallel.

---

# 10. Dynamic Table Discovery

Because the requirement says that the microservice needs to go through the relevant BigQuery tables, first investigate the actual BigQuery structure.

Determine whether the best architecture is:

### Option A — Known relevant tables

If the relevant tables are clearly identifiable, explicitly configure them in the service.

OR

### Option B — Multiple historical tables

If data is split across multiple monthly/yearly tables, build a query strategy that identifies and queries the relevant tables dynamically.

For example:

```text
orders_2026_01
orders_2026_02
orders_2026_03
...
```

In this scenario, only query the tables required for the last six months.

Do not build an unnecessarily complex dynamic table scanner if the existing BigQuery architecture already provides a clean canonical table/view.

Choose the simplest reliable architecture based on the actual data structure you discover.

---

# 11. Security

The service account credentials must NEVER be:

* Hardcoded into source code
* Committed to Git
* Returned through an API
* Logged
* Exposed to the frontend

Use environment variables or the existing secure credential mechanism.

Add an appropriate `.gitignore` if required.

If a service-account JSON file exists locally, make sure it is not accidentally committed.

---

# 12. Node.js Requirements

Use:

* Node.js
* TypeScript if the project supports it; otherwise clean JavaScript
* Official Google Cloud BigQuery Node.js client
* Express/Fastify or the existing framework in the repository
* Environment-based configuration

Use a clean project structure.

For example:

```text
src/
├── controllers/
│   └── metrics.controller.ts
├── routes/
│   └── metrics.routes.ts
├── services/
│   └── metrics.service.ts
├── repositories/
│   └── bigquery.repository.ts
├── config/
│   └── bigquery.ts
├── utils/
│   └── date.ts
├── types/
│   └── metrics.ts
└── app.ts
```

Adapt this structure to the existing project instead of unnecessarily restructuring an existing application.

---

# 13. Error Handling

Implement proper error handling.

Examples:

### Missing pincode

```json
{
  "success": false,
  "error": {
    "code": "INVALID_PINCODE",
    "message": "Pincode is required."
  }
}
```

### No data

```json
{
  "success": true,
  "data": {
    "pincode": "400092",
    "metrics": {
      "averageOrderValue": null,
      "conversionRate": null
    }
  },
  "message": "No data found for the requested pincode and period."
}
```

### BigQuery/API failure

Return an appropriate 5xx response without exposing internal credentials, SQL, or sensitive infrastructure information.

Add structured logging for debugging.

---

# 14. Frontend Integration

Also create/document the API contract that the frontend can consume.

The frontend requirement is:

```text
Pincode Input
     ↓
Call Metrics API
     ↓
Display:
     ├── Average Order Value
     └── Conversion Rate
```

Example frontend response display:

```text
Pincode: 400092

Average Order Value
₹18,500

Conversion Rate
12.45%
```

If there is already a frontend application in the repository, inspect it and integrate the API into the existing frontend rather than creating a separate frontend application unnecessarily.

If the frontend does not exist, only create the backend/API unless specifically required.

---

# 15. API Documentation

Create API documentation containing:

### Endpoint

```text
GET /api/v1/metrics?pincode={pincode}
```

### Parameters

| Parameter | Type   | Required | Description                            |
| --------- | ------ | -------- | -------------------------------------- |
| pincode   | string | Yes      | Pincode for which metrics are required |

### Response

Document the complete JSON response.

Also provide a curl example:

```bash
curl "http://localhost:3000/api/v1/metrics?pincode=400092"
```

---

# 16. Testing

Add tests for:

1. Valid pincode
2. Missing pincode
3. Invalid pincode
4. Pincode with no data
5. AOV calculation
6. Conversion-rate calculation
7. Last-six-month date filtering
8. BigQuery errors
9. API response structure

Where possible, mock BigQuery in unit tests rather than making real BigQuery calls.

---

# 17. Validation of Metrics

This is very important.

After implementing the queries:

* Run the queries against BigQuery
* Test with at least 2–3 different pincodes
* Validate the returned order count
* Validate total order value
* Validate AOV calculation
* Validate total eligible leads
* Validate converted leads
* Validate conversion-rate calculation

Provide the SQL queries used for validation.

If you find discrepancies or ambiguity in how conversion should be calculated, **do not silently make an assumption**. Clearly explain the ambiguity and the data fields you found.

---

# 18. Deliverables

At the end, I expect the following:

### Backend

* Node.js microservice
* BigQuery integration
* Metrics service
* API endpoint
* Error handling
* Logging
* Configuration
* Tests

### Metrics

* AOV for pincode — last 6 months
* Conversion Rate for pincode — last 6 months

### Documentation

Create/update a README containing:

1. Architecture
2. BigQuery tables used
3. Relevant columns used
4. Definition/formula for AOV
5. Definition/formula for Conversion Rate
6. Date-range logic
7. API endpoint
8. Request/response examples
9. Environment variables
10. Local setup instructions
11. How to run the service
12. How to test the API
13. BigQuery SQL/query logic

---

# 19. Critical Instructions

Before implementing anything:

**FIRST inspect the repository, service-account configuration, BigQuery datasets, tables and schemas.**

Do not invent:

* Dataset names
* Table names
* Column names
* Pincode fields
* Order fields
* Conversion fields
* Status values
* Business definitions

Base the implementation on the actual data available.

If you encounter multiple possible definitions for conversion rate, identify them and explain which one you selected and why.

Keep the implementation **simple, production-ready, secure, performant and maintainable**.

Do not create unnecessary infrastructure or over-engineer the solution.

Start by inspecting the existing files and BigQuery structure, then explain your findings and proposed architecture briefly before implementing the microservice.
