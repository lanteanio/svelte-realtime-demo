CREATE TABLE board (
    board_id     uuid         DEFAULT gen_random_uuid() PRIMARY KEY,
    title        text         NOT NULL,
    slug         text         NOT NULL UNIQUE,
    background   text         DEFAULT '#f5f5f4' NOT NULL,
    created_at   timestamptz  DEFAULT now() NOT NULL
);

CREATE TABLE note (
    note_id      uuid         DEFAULT gen_random_uuid() PRIMARY KEY,
    board_id     uuid         NOT NULL
                              REFERENCES board (board_id) ON DELETE CASCADE,
    content      text         DEFAULT '' NOT NULL,
    x            integer      DEFAULT 200 NOT NULL,
    y            integer      DEFAULT 200 NOT NULL,
    color        text         DEFAULT '#fef08a' NOT NULL,
    creator_name text         NOT NULL,
    is_archived  boolean      DEFAULT FALSE NOT NULL,
    created_at   timestamptz  DEFAULT now() NOT NULL
);

CREATE INDEX note_board_id_idx ON note (board_id) WHERE NOT is_archived;

-- Auto-archive notes older than 24h
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

-- Uncomment if pg_cron is available:
-- SELECT cron.schedule('archive-notes', '*/5 * * * *', 'SELECT archive_old_notes()');
