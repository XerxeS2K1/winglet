"""Review finding #32: a routine-history sync writes only the runs that changed."""
from test_routine_history import execution, history, source  # noqa: F401  (fixture and builders)


def count_run_writes(history):
    writes = []
    history.db.set_trace_callback(lambda sql: writes.append(sql) if "INSERT INTO routine_history_runs" in sql else None)
    return writes


def test_a_sync_that_observes_nothing_new_rewrites_no_run(history):
    runs = [execution(f"run-{n}") for n in range(5)]
    assert history.sync("researcher", source(*runs))
    writes = count_run_writes(history)
    assert history.sync("researcher", source(*runs)) == []
    assert writes == []


def test_only_the_run_that_changed_is_written_and_reported(history):
    runs = [execution(f"run-{n}", status="running") for n in range(4)]
    history.sync("researcher", source(*runs))
    writes = count_run_writes(history)
    runs[2] = execution("run-2", status="completed")
    changed = history.sync("researcher", source(*runs))
    assert [c["run_id"] for c in changed] == ["run-2"] and len(writes) == 1
    page = history.page("researcher", "job")["runs"]
    assert {r["id"]: r["status"] for r in page}["run-2"] == "completed"
