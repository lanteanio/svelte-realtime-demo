-- Core application schema and database-level mirrors of RPC validation.
-- Existing invalid legacy rows are repaired before constraints are validated.
-- Forward-only/expand-compatible: rollback uses the prior app image against
-- this additive schema and does not remove these columns, constraints, or data.

CREATE TABLE IF NOT EXISTS board (
    board_id       uuid         DEFAULT gen_random_uuid() PRIMARY KEY,
    title          text         NOT NULL,
    slug           text         NOT NULL UNIQUE,
    background     text         DEFAULT '#f5f5f4' NOT NULL,
    last_activity  timestamptz  DEFAULT now() NOT NULL,
    created_at     timestamptz  DEFAULT now() NOT NULL
);

ALTER TABLE board
    ADD COLUMN IF NOT EXISTS last_activity timestamptz DEFAULT now();
UPDATE board
   SET last_activity = COALESCE(created_at, now())
 WHERE last_activity IS NULL;
ALTER TABLE board
    ALTER COLUMN last_activity SET DEFAULT now(),
    ALTER COLUMN last_activity SET NOT NULL;

-- Normalize before the blank fallback: a legacy value made of 100 spaces
-- followed by text must not truncate into a constraint-invalid blank title.
UPDATE board SET title = left(btrim(title), 100) WHERE char_length(title) > 100;
UPDATE board SET title = 'Untitled board' WHERE char_length(btrim(title)) = 0;
UPDATE board SET background = '#f5f5f4'
 WHERE background !~ '^#[0-9A-Fa-f]{6}$';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'board'::regclass AND conname = 'board_title_check'
    ) THEN
        ALTER TABLE board ADD CONSTRAINT board_title_check
            CHECK (char_length(btrim(title)) BETWEEN 1 AND 100) NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'board'::regclass AND conname = 'board_background_check'
    ) THEN
        ALTER TABLE board ADD CONSTRAINT board_background_check
            CHECK (background ~ '^#[0-9A-Fa-f]{6}$') NOT VALID;
    END IF;
END
$$;

ALTER TABLE board VALIDATE CONSTRAINT board_title_check;
ALTER TABLE board VALIDATE CONSTRAINT board_background_check;

CREATE INDEX IF NOT EXISTS board_created_at_desc_idx ON board (created_at DESC);
CREATE INDEX IF NOT EXISTS board_last_activity_idx ON board (last_activity);

CREATE TABLE IF NOT EXISTS note (
    note_id      uuid         DEFAULT gen_random_uuid() PRIMARY KEY,
    board_id     uuid         NOT NULL REFERENCES board (board_id) ON DELETE CASCADE,
    content      text         DEFAULT '' NOT NULL,
    x            integer      DEFAULT 200 NOT NULL,
    y            integer      DEFAULT 200 NOT NULL,
    color        text         DEFAULT '#fef08a' NOT NULL,
    creator_name text         NOT NULL,
    z_index      integer      DEFAULT 0 NOT NULL,
    is_archived  boolean      DEFAULT FALSE NOT NULL,
    created_at   timestamptz  DEFAULT now() NOT NULL
);

ALTER TABLE note ADD COLUMN IF NOT EXISTS z_index integer DEFAULT 0;
UPDATE note SET z_index = 0 WHERE z_index IS NULL;
ALTER TABLE note
    ALTER COLUMN z_index SET DEFAULT 0,
    ALTER COLUMN z_index SET NOT NULL;

UPDATE note SET content = left(content, 2000) WHERE char_length(content) > 2000;
UPDATE note SET x = greatest(-10000, least(10000, x)) WHERE x NOT BETWEEN -10000 AND 10000;
UPDATE note SET y = greatest(-10000, least(10000, y)) WHERE y NOT BETWEEN -10000 AND 10000;
UPDATE note SET color = '#fef08a' WHERE color !~ '^#[0-9A-Fa-f]{6}$';
UPDATE note SET creator_name = left(btrim(creator_name), 40) WHERE char_length(creator_name) > 40;
UPDATE note SET creator_name = 'Anonymous' WHERE char_length(btrim(creator_name)) = 0;
UPDATE note SET z_index = 0 WHERE z_index < 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'note'::regclass AND conname = 'note_content_check'
    ) THEN
        ALTER TABLE note ADD CONSTRAINT note_content_check
            CHECK (char_length(content) <= 2000) NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'note'::regclass AND conname = 'note_x_check'
    ) THEN
        ALTER TABLE note ADD CONSTRAINT note_x_check
            CHECK (x BETWEEN -10000 AND 10000) NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'note'::regclass AND conname = 'note_y_check'
    ) THEN
        ALTER TABLE note ADD CONSTRAINT note_y_check
            CHECK (y BETWEEN -10000 AND 10000) NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'note'::regclass AND conname = 'note_color_check'
    ) THEN
        ALTER TABLE note ADD CONSTRAINT note_color_check
            CHECK (color ~ '^#[0-9A-Fa-f]{6}$') NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'note'::regclass AND conname = 'note_creator_name_check'
    ) THEN
        ALTER TABLE note ADD CONSTRAINT note_creator_name_check
            CHECK (char_length(btrim(creator_name)) BETWEEN 1 AND 40) NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'note'::regclass AND conname = 'note_z_index_check'
    ) THEN
        ALTER TABLE note ADD CONSTRAINT note_z_index_check
            CHECK (z_index >= 0) NOT VALID;
    END IF;
END
$$;

ALTER TABLE note VALIDATE CONSTRAINT note_content_check;
ALTER TABLE note VALIDATE CONSTRAINT note_x_check;
ALTER TABLE note VALIDATE CONSTRAINT note_y_check;
ALTER TABLE note VALIDATE CONSTRAINT note_color_check;
ALTER TABLE note VALIDATE CONSTRAINT note_creator_name_check;
ALTER TABLE note VALIDATE CONSTRAINT note_z_index_check;

CREATE INDEX IF NOT EXISTS note_board_id_idx ON note (board_id) WHERE NOT is_archived;

CREATE OR REPLACE FUNCTION archive_old_notes()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_note record;
BEGIN
    FOR v_note IN
        UPDATE note
           SET is_archived = TRUE
         WHERE created_at < now() - INTERVAL '24 hours'
           AND NOT is_archived
     RETURNING *
    LOOP
        PERFORM pg_notify(
            'table_changes',
            json_build_object(
                'topic', 'board:' || v_note.board_id || ':notes',
                'event', 'deleted',
                'data',  json_build_object('note_id', v_note.note_id)
            )::text
        );
    END LOOP;
END;
$$;
