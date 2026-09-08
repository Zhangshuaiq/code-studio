CREATE UNIQUE INDEX "Task_one_active_per_session_idx"
ON "Task"("sessionId")
WHERE "status" IN ('queued', 'running');
