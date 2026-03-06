-- ============================================================
-- Atlas Embed Webhook Triggers for new intelligence tables
-- Creates INSERT triggers that call the 'embed' Edge Function
-- via pg_net http_post (async, non-blocking)
-- ============================================================

-- Ensure pg_net extension is available
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Webhook trigger for feedback table
CREATE OR REPLACE FUNCTION trigger_embed_feedback()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM net.http_post(
    url := 'https://ctiknmztlqqjzhgmyfbu.supabase.co/functions/v1/embed',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0aWtubXp0bHFxanpoZ215ZmJ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA5ODEyNTIsImV4cCI6MjA4NjU1NzI1Mn0.mI601PW8FUqQOpJRLdmAgLlfioo4_siftyfWEhTiV-o"}'::JSONB,
    body := jsonb_build_object(
      'record', jsonb_build_object(
        'id', NEW.id,
        'correction_text', NEW.correction_text,
        'context_summary', NEW.context_summary,
        'feedback_message', NEW.feedback_message,
        'embedding', NEW.embedding
      ),
      'table', 'feedback'
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_embed_feedback ON feedback;
CREATE TRIGGER trg_embed_feedback
  AFTER INSERT ON feedback
  FOR EACH ROW
  WHEN (NEW.embedding IS NULL)
  EXECUTE FUNCTION trigger_embed_feedback();

-- Webhook trigger for episodes table
CREATE OR REPLACE FUNCTION trigger_embed_episodes()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM net.http_post(
    url := 'https://ctiknmztlqqjzhgmyfbu.supabase.co/functions/v1/embed',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0aWtubXp0bHFxanpoZ215ZmJ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA5ODEyNTIsImV4cCI6MjA4NjU1NzI1Mn0.mI601PW8FUqQOpJRLdmAgLlfioo4_siftyfWEhTiV-o"}'::JSONB,
    body := jsonb_build_object(
      'record', jsonb_build_object(
        'id', NEW.id,
        'trigger', NEW.trigger,
        'outcome', NEW.outcome,
        'lessons', NEW.lessons,
        'embedding', NEW.embedding
      ),
      'table', 'episodes'
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_embed_episodes ON episodes;
CREATE TRIGGER trg_embed_episodes
  AFTER INSERT ON episodes
  FOR EACH ROW
  WHEN (NEW.embedding IS NULL)
  EXECUTE FUNCTION trigger_embed_episodes();

-- Webhook trigger for observations table
CREATE OR REPLACE FUNCTION trigger_embed_observations()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM net.http_post(
    url := 'https://ctiknmztlqqjzhgmyfbu.supabase.co/functions/v1/embed',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0aWtubXp0bHFxanpoZ215ZmJ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA5ODEyNTIsImV4cCI6MjA4NjU1NzI1Mn0.mI601PW8FUqQOpJRLdmAgLlfioo4_siftyfWEhTiV-o"}'::JSONB,
    body := jsonb_build_object(
      'record', jsonb_build_object(
        'id', NEW.id,
        'observation_text', NEW.observation_text,
        'embedding', NEW.embedding
      ),
      'table', 'observations'
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_embed_observations ON observations;
CREATE TRIGGER trg_embed_observations
  AFTER INSERT ON observations
  FOR EACH ROW
  WHEN (NEW.embedding IS NULL)
  EXECUTE FUNCTION trigger_embed_observations();
