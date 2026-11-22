CREATE TABLE "services" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"environment" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spans" (
	"trace_id" char(32) NOT NULL,
	"span_id" char(16) NOT NULL,
	"parent_span_id" char(16),
	"service_id" integer NOT NULL,
	"operation_name" text NOT NULL,
	"kind" smallint NOT NULL,
	"start_time" timestamp (6) with time zone NOT NULL,
	"start_unix_nano" bigint NOT NULL,
	"end_unix_nano" bigint NOT NULL,
	"duration_ms" double precision NOT NULL,
	"status_code" smallint NOT NULL,
	"status_message" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resource_attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scope_name" text,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spans_pkey" PRIMARY KEY("trace_id","span_id")
);
--> statement-breakpoint
CREATE TABLE "traces" (
	"trace_id" char(32) PRIMARY KEY NOT NULL,
	"root_service_id" integer,
	"root_service" text,
	"root_operation" text,
	"root_span_id" char(16),
	"has_root" boolean DEFAULT false NOT NULL,
	"start_time" timestamp (6) with time zone NOT NULL,
	"end_time" timestamp (6) with time zone NOT NULL,
	"start_unix_nano" bigint NOT NULL,
	"end_unix_nano" bigint NOT NULL,
	"duration_ms" double precision NOT NULL,
	"status" text NOT NULL,
	"span_count" integer NOT NULL,
	"error_count" integer NOT NULL,
	"orphan_count" integer DEFAULT 0 NOT NULL,
	"services" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spans" ADD CONSTRAINT "spans_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_root_service_id_services_id_fk" FOREIGN KEY ("root_service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "services_name_env_uq" ON "services" USING btree ("name","environment");--> statement-breakpoint
CREATE INDEX "spans_service_start_idx" ON "spans" USING btree ("service_id","start_time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "spans_start_time_idx" ON "spans" USING btree ("start_time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "spans_trace_parent_idx" ON "spans" USING btree ("trace_id","parent_span_id");--> statement-breakpoint
CREATE INDEX "traces_start_time_idx" ON "traces" USING btree ("start_time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "traces_root_service_start_idx" ON "traces" USING btree ("root_service","start_time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "traces_duration_idx" ON "traces" USING btree ("duration_ms" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "traces_errors_start_idx" ON "traces" USING btree ("start_time" DESC NULLS LAST) WHERE "traces"."status" = 'error';--> statement-breakpoint
CREATE INDEX "traces_services_gin_idx" ON "traces" USING gin ("services");