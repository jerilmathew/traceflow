-- Runs once, when the data volume is first created.
-- traceflow_test / traceflow_e2e isolate automated tests from your dev data.
-- inventory_demo is the *application* database used by the example Inventory
-- service, so its queries produce genuine PostgreSQL client spans.
CREATE DATABASE traceflow_test OWNER traceflow;
CREATE DATABASE traceflow_e2e OWNER traceflow;
CREATE DATABASE inventory_demo OWNER traceflow;
