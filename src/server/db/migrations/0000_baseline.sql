CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"direct_role" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_former_member" (
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"removed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "org_former_member_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "org_group" (
	"organization_id" text NOT NULL,
	"group_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "org_group_organization_id_group_id_pk" PRIMARY KEY("organization_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "org_invite" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_by" text,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "org_invite_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "org_setting" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"default_model" text,
	"title_model" text,
	"default_effort" text,
	"space_creation" text DEFAULT 'members' NOT NULL,
	"member_spaces" boolean DEFAULT false NOT NULL,
	"space_mcp_servers" boolean DEFAULT true NOT NULL,
	"space_skills" boolean DEFAULT true NOT NULL,
	"agent_name" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp with time zone NOT NULL,
	"metadata" text,
	"kind" text NOT NULL,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "scim_connection_binding" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"connection_key" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"decommissioned_at" timestamp with time zone,
	"decommission_status" text DEFAULT 'active' NOT NULL,
	"decommission_cursor_user_id" text,
	"decommission_reconciled_user_count" integer DEFAULT 0 NOT NULL,
	"decommission_batch_count" integer DEFAULT 0 NOT NULL,
	"decommission_revision" integer DEFAULT 0 NOT NULL,
	"decommission_completed_at" timestamp with time zone,
	"decommission_lease_id" text,
	"decommission_lease_expires_at" timestamp with time zone,
	CONSTRAINT "scim_connection_binding_connection_key_unique" UNIQUE("connection_key")
);
--> statement-breakpoint
CREATE TABLE "scim_group" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"display_name" text NOT NULL,
	"display_name_key" text NOT NULL,
	"external_id" text,
	"external_id_key" text,
	"email" text,
	"email_key" text,
	"order_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_group_display_name_key_unique" UNIQUE("display_name_key"),
	CONSTRAINT "scim_group_external_id_key_unique" UNIQUE("external_id_key"),
	CONSTRAINT "scim_group_order_key_unique" UNIQUE("order_key")
);
--> statement-breakpoint
CREATE TABLE "scim_group_member" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"group_id" text NOT NULL,
	"scim_user_id" text NOT NULL,
	"membership_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_group_member_membership_key_unique" UNIQUE("membership_key")
);
--> statement-breakpoint
CREATE TABLE "scim_identity_tombstone" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"external_id" text NOT NULL,
	"external_id_key" text NOT NULL,
	"user_id" text NOT NULL,
	"profile" text NOT NULL,
	"deleted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_identity_tombstone_external_id_key_unique" UNIQUE("external_id_key")
);
--> statement-breakpoint
CREATE TABLE "scim_projection_grant" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"scim_user_id" text NOT NULL,
	"user_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"source_value" text,
	"role" text NOT NULL,
	"grant_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_projection_grant_grant_key_unique" UNIQUE("grant_key")
);
--> statement-breakpoint
CREATE TABLE "scim_subject" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"profile_source_id" text,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_subject_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "scim_user" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"provisioning_domain_id" text NOT NULL,
	"user_id" text NOT NULL,
	"connection_user_key" text NOT NULL,
	"user_name" text NOT NULL,
	"user_name_key" text NOT NULL,
	"primary_email" text NOT NULL,
	"work_email_value_index" text NOT NULL,
	"email_value_index" text NOT NULL,
	"display_name" text NOT NULL,
	"formatted_name" text NOT NULL,
	"given_name" text,
	"family_name" text,
	"serialized_emails" text NOT NULL,
	"serialized_attributes" text,
	"external_id" text,
	"external_id_key" text,
	"active" boolean NOT NULL,
	"order_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scim_user_connection_user_key_unique" UNIQUE("connection_user_key"),
	CONSTRAINT "scim_user_user_name_key_unique" UNIQUE("user_name_key"),
	CONSTRAINT "scim_user_external_id_key_unique" UNIQUE("external_id_key"),
	CONSTRAINT "scim_user_order_key_unique" UNIQUE("order_key")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"created_by" text,
	"host" text NOT NULL,
	"auth_kind" text NOT NULL,
	"account" text NOT NULL,
	"label" text,
	"settings" json,
	"auto_enable_models" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection_model" (
	"connection_id" text NOT NULL,
	"model_id" text NOT NULL,
	"enabled" boolean NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "connection_model_connection_id_model_id_pk" PRIMARY KEY("connection_id","model_id")
);
--> statement-breakpoint
CREATE TABLE "credential" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"key_version" integer NOT NULL,
	"sealed" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "space" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"default_model" text,
	"default_effort" text,
	"agent_name" text,
	"everyone_role" text,
	"created_by" text,
	"archived_at" timestamp with time zone,
	"trashed_at" timestamp with time zone,
	"trashed_by" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "space_member" (
	"space_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"role" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "space_member_space_id_subject_kind_subject_id_pk" PRIMARY KEY("space_id","subject_kind","subject_id")
);
--> statement-breakpoint
CREATE TABLE "mcp_credential" (
	"server_id" text NOT NULL,
	"holder_kind" text NOT NULL,
	"holder_id" text NOT NULL,
	"key_version" integer NOT NULL,
	"sealed" "bytea" NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "mcp_credential_server_id_holder_kind_holder_id_pk" PRIMARY KEY("server_id","holder_kind","holder_id")
);
--> statement-breakpoint
CREATE TABLE "mcp_server" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"space_id" text,
	"name" text NOT NULL,
	"slug" text,
	"url" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"auth_kind" text NOT NULL,
	"credentials" text DEFAULT 'shared' NOT NULL,
	"settings" json NOT NULL,
	"transport" text,
	"protocol_version" text,
	"status" text NOT NULL,
	"error" text,
	"server_info" json,
	"instructions" text,
	"instructions_cut" boolean DEFAULT false NOT NULL,
	"resources" boolean DEFAULT false NOT NULL,
	"tools" json NOT NULL,
	"prompts" json DEFAULT '[]'::json NOT NULL,
	"tools_read_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "space_mcp_server_setting" (
	"space_id" text NOT NULL,
	"server_id" text NOT NULL,
	"enabled" boolean NOT NULL,
	CONSTRAINT "space_mcp_server_setting_space_id_server_id_pk" PRIMARY KEY("space_id","server_id")
);
--> statement-breakpoint
CREATE TABLE "instruction" (
	"scope_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"space_id" text,
	"text" text NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "builtin_skill_setting" (
	"organization_id" text NOT NULL,
	"space_id" text,
	"key" text NOT NULL,
	"enabled" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"space_id" text,
	"source_id" text,
	"path" text,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"body" text NOT NULL,
	"files" json NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_source" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"space_id" text,
	"label" text NOT NULL,
	"url" text NOT NULL,
	"ref" text,
	"resolved_ref" text,
	"subpath" text,
	"commit" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"token_key_version" integer,
	"token" "bytea",
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "space_skill_setting" (
	"space_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"enabled" boolean NOT NULL,
	CONSTRAINT "space_skill_setting_space_id_skill_id_pk" PRIMARY KEY("space_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "space_skill_source_setting" (
	"space_id" text NOT NULL,
	"source_id" text NOT NULL,
	"enabled" boolean NOT NULL,
	CONSTRAINT "space_skill_source_setting_space_id_source_id_pk" PRIMARY KEY("space_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "background_call" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"run_id" text NOT NULL,
	"tool_id" text NOT NULL,
	"input" json,
	"status" text NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"lease_epoch" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "call_output" (
	"call_id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"progress" json
);
--> statement-breakpoint
CREATE TABLE "call_output_chunk" (
	"call_id" text NOT NULL,
	"offset" integer NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "call_output_chunk_call_id_offset_pk" PRIMARY KEY("call_id","offset")
);
--> statement-breakpoint
CREATE TABLE "run" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"status" text NOT NULL,
	"trigger_seq" integer NOT NULL,
	"model" text,
	"asked_model" text,
	"asked_effort" text,
	"continues_run_id" text,
	"reason" text,
	"created_by" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"cancel_requested_by" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"lease_epoch" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subagent" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"parent_thread_id" text NOT NULL,
	"name" text NOT NULL,
	"instructions" text,
	"share_tasks" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_task" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"assignee" json,
	"position" integer NOT NULL,
	"created_by" json NOT NULL,
	"updated_by" json NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "thread_tool" (
	"thread_id" text NOT NULL,
	"tool_id" text NOT NULL,
	"call_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "thread_tool_thread_id_tool_id_pk" PRIMARY KEY("thread_id","tool_id")
);
--> statement-breakpoint
CREATE TABLE "thread_trigger" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"cron" text,
	"timezone" text,
	"prompt" text NOT NULL,
	"steered_by" json NOT NULL,
	"created_by_label" text NOT NULL,
	"status" text NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_fired_at" timestamp with time zone,
	"hook_token" text,
	"secret_key_version" integer,
	"secret" "bytea",
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_watch" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"kind" text NOT NULL,
	"until" text NOT NULL,
	"call_id" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_watch_subject" (
	"watch_id" text NOT NULL,
	"subject_id" text NOT NULL,
	CONSTRAINT "thread_watch_subject_watch_id_subject_id_pk" PRIMARY KEY("watch_id","subject_id")
);
--> statement-breakpoint
CREATE TABLE "tool_policy" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"space_id" text,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"use" text NOT NULL,
	"independent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_policy_member" (
	"policy_id" text NOT NULL,
	"role" text NOT NULL,
	"key" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "tool_policy_member_policy_id_role_key_pk" PRIMARY KEY("policy_id","role","key")
);
--> statement-breakpoint
CREATE TABLE "tool_setting" (
	"organization_id" text NOT NULL,
	"space_id" text,
	"tool_id" text NOT NULL,
	"policy_id" text
);
--> statement-breakpoint
CREATE TABLE "toolset_option" (
	"organization_id" text NOT NULL,
	"space_id" text,
	"toolset_id" text NOT NULL,
	"option" text NOT NULL,
	"enabled" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "toolset_setting" (
	"organization_id" text NOT NULL,
	"space_id" text,
	"toolset_id" text NOT NULL,
	"enabled" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aside" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"row_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aside_turn" (
	"id" text PRIMARY KEY NOT NULL,
	"aside_id" text NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"model" text,
	"failed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_delta" (
	"thread_id" text NOT NULL,
	"message_id" text NOT NULL,
	"idx" integer NOT NULL,
	"text" text NOT NULL,
	"part" text DEFAULT 'text' NOT NULL,
	CONSTRAINT "message_delta_message_id_idx_pk" PRIMARY KEY("message_id","idx")
);
--> statement-breakpoint
CREATE TABLE "thread" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"title" text,
	"title_source" text,
	"model" text,
	"effort" text,
	"created_by" text,
	"root_thread_id" text,
	"current_branch_id" text NOT NULL,
	"org_access" text DEFAULT 'none' NOT NULL,
	"last_event_seq" integer DEFAULT 0 NOT NULL,
	"last_message_text" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_background_seen" (
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"kind" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "thread_background_seen_user_id_thread_id_kind_pk" PRIMARY KEY("user_id","thread_id","kind")
);
--> statement-breakpoint
CREATE TABLE "thread_branch" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"parent_branch_id" text,
	"fork_seq" integer,
	"kind" text NOT NULL,
	"row_id" text,
	"group_row_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_branch_source" (
	"branch_id" text NOT NULL,
	"source_branch_id" text NOT NULL,
	"until_seq" integer,
	CONSTRAINT "thread_branch_source_branch_id_source_branch_id_pk" PRIMARY KEY("branch_id","source_branch_id")
);
--> statement-breakpoint
CREATE TABLE "thread_event" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"branch_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" text,
	"data" json NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_read" (
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"last_seen_seq" integer NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "thread_read_user_id_thread_id_pk" PRIMARY KEY("user_id","thread_id")
);
--> statement-breakpoint
CREATE TABLE "tool_result" (
	"event_id" text PRIMARY KEY NOT NULL,
	"value" json NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_group_guest" (
	"thread_id" text NOT NULL,
	"group_id" text NOT NULL,
	"invited_by" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"role" text DEFAULT 'message' NOT NULL,
	"access_until" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "thread_group_guest_thread_id_group_id_pk" PRIMARY KEY("thread_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "thread_guest" (
	"thread_id" text NOT NULL,
	"user_id" text NOT NULL,
	"invited_by" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"role" text DEFAULT 'message' NOT NULL,
	"access_until" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "thread_guest_thread_id_user_id_pk" PRIMARY KEY("thread_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "thread_invite" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"link_expires_at" timestamp with time zone NOT NULL,
	"access_for" text NOT NULL,
	"role" text DEFAULT 'message' NOT NULL,
	"accepted_by" text,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "thread_invite_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "artifact" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"created_in_thread_id" text,
	"sharing" text DEFAULT 'space' NOT NULL,
	"org_role" text DEFAULT 'view' NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_asset" (
	"artifact_id" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "artifact_asset_artifact_id_name_pk" PRIMARY KEY("artifact_id","name")
);
--> statement-breakpoint
CREATE TABLE "artifact_group_share" (
	"artifact_id" text NOT NULL,
	"group_id" text NOT NULL,
	"role" text DEFAULT 'view' NOT NULL,
	"shared_by" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "artifact_group_share_artifact_id_group_id_pk" PRIMARY KEY("artifact_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "artifact_person_share" (
	"artifact_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'view' NOT NULL,
	"shared_by" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "artifact_person_share_artifact_id_user_id_pk" PRIMARY KEY("artifact_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "artifact_setting" (
	"organization_id" text NOT NULL,
	"space_id" text,
	"public_allowed" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifact_thread_use" (
	"artifact_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"guests_shared_at" timestamp with time zone,
	"guests_shared_by" text,
	CONSTRAINT "artifact_thread_use_artifact_id_thread_id_pk" PRIMARY KEY("artifact_id","thread_id")
);
--> statement-breakpoint
CREATE TABLE "artifact_version" (
	"artifact_id" text NOT NULL,
	"version" integer NOT NULL,
	"label" text,
	"html" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"icon" text NOT NULL,
	"thread_id" text,
	"run_id" text,
	"background_call_id" text,
	"call_id" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "artifact_version_artifact_id_version_pk" PRIMARY KEY("artifact_id","version"),
	CONSTRAINT "artifact_version_origin_check" CHECK ("artifact_version"."run_id" is null or "artifact_version"."background_call_id" is null)
);
--> statement-breakpoint
CREATE TABLE "bus_message" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"origin" text NOT NULL,
	"channel" text NOT NULL,
	"payload" json,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_former_member" ADD CONSTRAINT "org_former_member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_former_member" ADD CONSTRAINT "org_former_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_group" ADD CONSTRAINT "org_group_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_group" ADD CONSTRAINT "org_group_group_id_scim_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."scim_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invite" ADD CONSTRAINT "org_invite_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invite" ADD CONSTRAINT "org_invite_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invite" ADD CONSTRAINT "org_invite_accepted_by_user_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_setting" ADD CONSTRAINT "org_setting_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_group_member" ADD CONSTRAINT "scim_group_member_group_id_scim_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."scim_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_group_member" ADD CONSTRAINT "scim_group_member_scim_user_id_scim_user_id_fk" FOREIGN KEY ("scim_user_id") REFERENCES "public"."scim_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_identity_tombstone" ADD CONSTRAINT "scim_identity_tombstone_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_projection_grant" ADD CONSTRAINT "scim_projection_grant_scim_user_id_scim_user_id_fk" FOREIGN KEY ("scim_user_id") REFERENCES "public"."scim_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_projection_grant" ADD CONSTRAINT "scim_projection_grant_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_subject" ADD CONSTRAINT "scim_subject_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_user" ADD CONSTRAINT "scim_user_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_model" ADD CONSTRAINT "connection_model_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space" ADD CONSTRAINT "space_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space" ADD CONSTRAINT "space_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space" ADD CONSTRAINT "space_trashed_by_user_id_fk" FOREIGN KEY ("trashed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_member" ADD CONSTRAINT "space_member_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_credential" ADD CONSTRAINT "mcp_credential_server_id_mcp_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_mcp_server_setting" ADD CONSTRAINT "space_mcp_server_setting_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_mcp_server_setting" ADD CONSTRAINT "space_mcp_server_setting_server_id_mcp_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruction" ADD CONSTRAINT "instruction_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruction" ADD CONSTRAINT "instruction_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instruction" ADD CONSTRAINT "instruction_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builtin_skill_setting" ADD CONSTRAINT "builtin_skill_setting_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builtin_skill_setting" ADD CONSTRAINT "builtin_skill_setting_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_source_id_skill_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."skill_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_source" ADD CONSTRAINT "skill_source_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_source" ADD CONSTRAINT "skill_source_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_source" ADD CONSTRAINT "skill_source_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_skill_setting" ADD CONSTRAINT "space_skill_setting_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_skill_setting" ADD CONSTRAINT "space_skill_setting_skill_id_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_skill_source_setting" ADD CONSTRAINT "space_skill_source_setting_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_skill_source_setting" ADD CONSTRAINT "space_skill_source_setting_source_id_skill_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."skill_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_call" ADD CONSTRAINT "background_call_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_call" ADD CONSTRAINT "background_call_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_output" ADD CONSTRAINT "call_output_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_output_chunk" ADD CONSTRAINT "call_output_chunk_call_id_call_output_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."call_output"("call_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_branch_id_thread_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."thread_branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_continues_run_id_run_id_fk" FOREIGN KEY ("continues_run_id") REFERENCES "public"."run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subagent" ADD CONSTRAINT "subagent_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subagent" ADD CONSTRAINT "subagent_parent_thread_id_thread_id_fk" FOREIGN KEY ("parent_thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_task" ADD CONSTRAINT "thread_task_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_tool" ADD CONSTRAINT "thread_tool_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_trigger" ADD CONSTRAINT "thread_trigger_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_watch" ADD CONSTRAINT "thread_watch_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_watch" ADD CONSTRAINT "thread_watch_owner_id_thread_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_watch_subject" ADD CONSTRAINT "thread_watch_subject_watch_id_thread_watch_id_fk" FOREIGN KEY ("watch_id") REFERENCES "public"."thread_watch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_policy" ADD CONSTRAINT "tool_policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_policy" ADD CONSTRAINT "tool_policy_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_policy_member" ADD CONSTRAINT "tool_policy_member_policy_id_tool_policy_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."tool_policy"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_setting" ADD CONSTRAINT "tool_setting_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_setting" ADD CONSTRAINT "tool_setting_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_setting" ADD CONSTRAINT "tool_setting_policy_id_tool_policy_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."tool_policy"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "toolset_option" ADD CONSTRAINT "toolset_option_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "toolset_option" ADD CONSTRAINT "toolset_option_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "toolset_setting" ADD CONSTRAINT "toolset_setting_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "toolset_setting" ADD CONSTRAINT "toolset_setting_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aside" ADD CONSTRAINT "aside_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aside" ADD CONSTRAINT "aside_branch_id_thread_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."thread_branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aside" ADD CONSTRAINT "aside_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aside_turn" ADD CONSTRAINT "aside_turn_aside_id_aside_id_fk" FOREIGN KEY ("aside_id") REFERENCES "public"."aside"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_delta" ADD CONSTRAINT "message_delta_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_root_thread_id_thread_id_fk" FOREIGN KEY ("root_thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_current_branch_id_thread_branch_id_fk" FOREIGN KEY ("current_branch_id") REFERENCES "public"."thread_branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_background_seen" ADD CONSTRAINT "thread_background_seen_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_background_seen" ADD CONSTRAINT "thread_background_seen_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_branch" ADD CONSTRAINT "thread_branch_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_branch" ADD CONSTRAINT "thread_branch_parent_branch_id_thread_branch_id_fk" FOREIGN KEY ("parent_branch_id") REFERENCES "public"."thread_branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_branch" ADD CONSTRAINT "thread_branch_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_branch_source" ADD CONSTRAINT "thread_branch_source_branch_id_thread_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."thread_branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_branch_source" ADD CONSTRAINT "thread_branch_source_source_branch_id_thread_branch_id_fk" FOREIGN KEY ("source_branch_id") REFERENCES "public"."thread_branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_event" ADD CONSTRAINT "thread_event_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_event" ADD CONSTRAINT "thread_event_branch_id_thread_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."thread_branch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_read" ADD CONSTRAINT "thread_read_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_read" ADD CONSTRAINT "thread_read_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_result" ADD CONSTRAINT "tool_result_event_id_thread_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."thread_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_group_guest" ADD CONSTRAINT "thread_group_guest_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_group_guest" ADD CONSTRAINT "thread_group_guest_group_id_scim_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."scim_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_group_guest" ADD CONSTRAINT "thread_group_guest_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_group_guest" ADD CONSTRAINT "thread_group_guest_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_guest" ADD CONSTRAINT "thread_guest_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_guest" ADD CONSTRAINT "thread_guest_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_guest" ADD CONSTRAINT "thread_guest_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_guest" ADD CONSTRAINT "thread_guest_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_invite" ADD CONSTRAINT "thread_invite_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_invite" ADD CONSTRAINT "thread_invite_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_invite" ADD CONSTRAINT "thread_invite_accepted_by_user_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_created_in_thread_id_thread_id_fk" FOREIGN KEY ("created_in_thread_id") REFERENCES "public"."thread"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_asset" ADD CONSTRAINT "artifact_asset_artifact_id_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_group_share" ADD CONSTRAINT "artifact_group_share_artifact_id_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_group_share" ADD CONSTRAINT "artifact_group_share_group_id_scim_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."scim_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_group_share" ADD CONSTRAINT "artifact_group_share_shared_by_user_id_fk" FOREIGN KEY ("shared_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_person_share" ADD CONSTRAINT "artifact_person_share_artifact_id_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_person_share" ADD CONSTRAINT "artifact_person_share_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_person_share" ADD CONSTRAINT "artifact_person_share_shared_by_user_id_fk" FOREIGN KEY ("shared_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_setting" ADD CONSTRAINT "artifact_setting_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_setting" ADD CONSTRAINT "artifact_setting_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_thread_use" ADD CONSTRAINT "artifact_thread_use_artifact_id_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_thread_use" ADD CONSTRAINT "artifact_thread_use_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_thread_use" ADD CONSTRAINT "artifact_thread_use_guests_shared_by_user_id_fk" FOREIGN KEY ("guests_shared_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_version" ADD CONSTRAINT "artifact_version_artifact_id_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_version" ADD CONSTRAINT "artifact_version_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_version" ADD CONSTRAINT "artifact_version_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_version" ADD CONSTRAINT "artifact_version_background_call_id_background_call_id_fk" FOREIGN KEY ("background_call_id") REFERENCES "public"."background_call"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "member_org_role_idx" ON "member" USING btree ("organization_id","role");--> statement-breakpoint
CREATE INDEX "org_group_group_idx" ON "org_group" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "org_invite_org_idx" ON "org_invite" USING btree ("organization_id","email");--> statement-breakpoint
CREATE INDEX "scim_connection_binding_connection_idx" ON "scim_connection_binding" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_group_connection_idx" ON "scim_group" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_group_domain_idx" ON "scim_group" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scim_group_email_idx" ON "scim_group" USING btree ("email_key");--> statement-breakpoint
CREATE INDEX "scim_group_member_connection_idx" ON "scim_group_member" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_group_member_group_idx" ON "scim_group_member" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "scim_group_member_scim_user_idx" ON "scim_group_member" USING btree ("scim_user_id");--> statement-breakpoint
CREATE INDEX "scim_identity_tombstone_connection_idx" ON "scim_identity_tombstone" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_identity_tombstone_domain_idx" ON "scim_identity_tombstone" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scim_identity_tombstone_user_idx" ON "scim_identity_tombstone" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scim_projection_grant_connection_idx" ON "scim_projection_grant" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_projection_grant_domain_idx" ON "scim_projection_grant" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scim_projection_grant_scim_user_idx" ON "scim_projection_grant" USING btree ("scim_user_id");--> statement-breakpoint
CREATE INDEX "scim_projection_grant_user_idx" ON "scim_projection_grant" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scim_subject_profile_source_idx" ON "scim_subject" USING btree ("profile_source_id");--> statement-breakpoint
CREATE INDEX "scim_user_connection_idx" ON "scim_user" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "scim_user_domain_idx" ON "scim_user" USING btree ("provisioning_domain_id");--> statement-breakpoint
CREATE INDEX "scim_user_user_idx" ON "scim_user" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_org_sign_in_idx" ON "connection" USING btree ("organization_id","host") WHERE "connection"."auth_kind" = 'oauth';--> statement-breakpoint
CREATE INDEX "space_org_idx" ON "space" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "space_member_subject_idx" ON "space_member" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "mcp_server_org_idx" ON "mcp_server" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "mcp_server_space_idx" ON "mcp_server" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "builtin_skill_setting_org_idx" ON "builtin_skill_setting" USING btree ("organization_id","key") WHERE "builtin_skill_setting"."space_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "builtin_skill_setting_space_idx" ON "builtin_skill_setting" USING btree ("space_id","key");--> statement-breakpoint
CREATE INDEX "skill_org_idx" ON "skill" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "skill_space_idx" ON "skill" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "skill_source_idx" ON "skill" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "skill_source_org_idx" ON "skill_source" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "skill_source_space_idx" ON "skill_source" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "background_call_thread_idx" ON "background_call" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "call_output_thread_idx" ON "call_output" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "run_thread_idx" ON "run" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "run_status_idx" ON "run" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "run_active_idx" ON "run" USING btree ("branch_id") WHERE "run"."status" in ('queued', 'running', 'waiting');--> statement-breakpoint
CREATE INDEX "subagent_parent_idx" ON "subagent" USING btree ("parent_thread_id","created_at");--> statement-breakpoint
CREATE INDEX "thread_task_thread_idx" ON "thread_task" USING btree ("thread_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_trigger_hook_token_idx" ON "thread_trigger" USING btree ("hook_token");--> statement-breakpoint
CREATE INDEX "thread_trigger_thread_idx" ON "thread_trigger" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "thread_trigger_due_idx" ON "thread_trigger" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "thread_watch_thread_idx" ON "thread_watch" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "thread_watch_owner_idx" ON "thread_watch" USING btree ("owner_id","kind");--> statement-breakpoint
CREATE INDEX "tool_policy_organization_idx" ON "tool_policy" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_setting_org_idx" ON "tool_setting" USING btree ("organization_id","tool_id") WHERE "tool_setting"."space_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_setting_space_idx" ON "tool_setting" USING btree ("space_id","tool_id");--> statement-breakpoint
CREATE UNIQUE INDEX "toolset_option_org_idx" ON "toolset_option" USING btree ("organization_id","toolset_id","option") WHERE "toolset_option"."space_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "toolset_option_space_idx" ON "toolset_option" USING btree ("space_id","toolset_id","option");--> statement-breakpoint
CREATE UNIQUE INDEX "toolset_setting_org_idx" ON "toolset_setting" USING btree ("organization_id","toolset_id") WHERE "toolset_setting"."space_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "toolset_setting_space_idx" ON "toolset_setting" USING btree ("space_id","toolset_id");--> statement-breakpoint
CREATE INDEX "aside_thread_user_idx" ON "aside" USING btree ("thread_id","user_id");--> statement-breakpoint
CREATE INDEX "aside_turn_aside_idx" ON "aside_turn" USING btree ("aside_id","created_at");--> statement-breakpoint
CREATE INDEX "message_delta_thread_idx" ON "message_delta" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "thread_space_idx" ON "thread" USING btree ("space_id","updated_at");--> statement-breakpoint
CREATE INDEX "thread_branch_thread_idx" ON "thread_branch" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_event_thread_seq_idx" ON "thread_event" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE INDEX "thread_event_thread_type_idx" ON "thread_event" USING btree ("thread_id","type","seq");--> statement-breakpoint
CREATE INDEX "thread_event_branch_idx" ON "thread_event" USING btree ("branch_id","seq");--> statement-breakpoint
CREATE INDEX "thread_group_guest_group_idx" ON "thread_group_guest" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "thread_guest_user_idx" ON "thread_guest" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "thread_invite_thread_idx" ON "thread_invite" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "artifact_space_idx" ON "artifact" USING btree ("space_id","updated_at");--> statement-breakpoint
CREATE INDEX "artifact_group_share_group_idx" ON "artifact_group_share" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "artifact_person_share_user_idx" ON "artifact_person_share" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_setting_org_idx" ON "artifact_setting" USING btree ("organization_id") WHERE "artifact_setting"."space_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_setting_space_idx" ON "artifact_setting" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "artifact_thread_use_thread_idx" ON "artifact_thread_use" USING btree ("thread_id");--> statement-breakpoint
-- A thread and its root branch name each other, so a thread is written before the branch it
-- names: the link is checked as the transaction ends.
ALTER TABLE "thread" ALTER CONSTRAINT "thread_current_branch_id_thread_branch_id_fk" DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
-- A group's roles in spaces name it by id without a link, so they go with it here.
CREATE FUNCTION "scim_group_space_roles"() RETURNS trigger AS $$
BEGIN
  DELETE FROM "space_member" WHERE "subject_kind" = 'group' AND "subject_id" = OLD."id";
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "scim_group_space_roles" AFTER DELETE ON "scim_group" FOR EACH ROW EXECUTE FUNCTION "scim_group_space_roles"();
