ALTER TABLE "organization_settings" ADD COLUMN "question_wait_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "default_answer" text;