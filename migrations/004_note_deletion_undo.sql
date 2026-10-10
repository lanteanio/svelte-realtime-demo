-- Deletion snapshots are private to the visitor who performed the action.
CREATE TABLE note_deletion (
    receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    board_id uuid NOT NULL REFERENCES board (board_id) ON DELETE CASCADE,
    actor_id uuid NOT NULL,
    note_id uuid NOT NULL,
    snapshot jsonb NOT NULL,
    expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '30 seconds')
);
CREATE INDEX note_deletion_owner_idx ON note_deletion (board_id, actor_id, expires_at DESC);
CREATE INDEX note_deletion_expiry_idx ON note_deletion (expires_at);
