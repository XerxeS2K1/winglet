"""What a bot is really doing: its own started/queued admissions count even when the gateway's 'active-work' query
fails, and an optional dispatcher job directory adds read-only detail rows. All data here is temporary."""
import json
import os
import sqlite3
import time

import pytest
from plugin import hermes_api
import sys
import types


class Gateway:
    """Stands in for the parts of Hermes that bot_activity asks (so these tests run without Hermes installed)."""
    def __init__(self):
        self.reply = {'active_agents': 0}
        self.error = None
        self.profiles = []

    def query(self, home, verb, **kwargs):
        if self.error:
            raise self.error
        return self.reply


@pytest.fixture
def activity(tmp_path, monkeypatch):
    gw = Gateway()
    def module(name, **attrs):
        mod = types.ModuleType(name)
        mod.__dict__.update(attrs)
        monkeypatch.setitem(sys.modules, name, mod)
        return mod
    module('gateway', __path__=[])
    module('gateway.control_socket', query_gateway_control=gw.query)
    module('gateway.session', _session_key_namespace=lambda profile: f'agent:{profile}')
    module('hermes_cli', __path__=[])
    module('hermes_cli.profiles', _get_default_hermes_home=lambda: tmp_path / 'host',
           profiles_to_serve=lambda **kw: gw.profiles)
    module('tools', __path__=[])
    module('tools.async_delegation', list_async_delegations=lambda: [], _LIVE_STATES=('running',))
    with sqlite3.connect(tmp_path / 'state.db') as db:
        db.execute('CREATE TABLE session_admissions (seq INTEGER PRIMARY KEY, request_id TEXT, status TEXT)')
    return tmp_path, gw


def _rows(home, *rows):
    with sqlite3.connect(home / 'state.db') as db:
        db.execute("ALTER TABLE session_admissions ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'")
        db.executemany('INSERT INTO session_admissions VALUES (?, ?, ?, ?)', rows)


def _payload(text, author='hermes'):
    return json.dumps({'text': text, 'local_automation_v1': {'turn_author': {'name': author}}})


# ---- native: a started admission is work, whatever 'active-work' says ----

@pytest.mark.parametrize('reply', [None, {}, {'active_agents': '0'}])
def test_a_started_admission_is_working_even_when_active_work_fails(activity, reply):
    home, gw = activity
    gw.reply = reply
    _rows(home, (1, 'bot:aaaa', 'started', _payload('Message from 🤖 Hermes (@hermes): TITLE: Study the sources')))
    result = hermes_api.bot_activity(home, 'research', include_queue=True)
    assert result['state'] == 'working'
    assert result['queue'][0]['status'] == 'started' and result['queue'][0]['title'] == 'Study the sources'


def test_a_started_admission_is_working_when_the_gateway_query_raises(activity):
    home, gw = activity
    gw.error = TimeoutError('control socket')
    _rows(home, (1, 'bot:aaaa', 'started', _payload('Do a thing')))
    assert hermes_api.bot_activity(home, 'research')['state'] == 'working'


def test_a_queued_admission_with_a_failed_query_is_listed_but_does_not_claim_running(activity):
    home, gw = activity
    gw.reply = None
    _rows(home, (1, 'bot:aaaa', 'queued', _payload('Do a thing')))
    result = hermes_api.bot_activity(home, 'research', include_queue=True)
    assert result['state'] == 'unknown' and result['queued'] == 1
    assert [row['status'] for row in result['queue']] == ['queued']


def test_a_failed_query_and_no_admissions_is_still_unknown(activity):
    home, gw = activity
    gw.reply = None
    assert hermes_api.bot_activity(home, 'research')['state'] == 'unknown'


# ---- optional dispatcher source ----

def _job(folder, name, *, status='running', stages=None, age=0, goal='Ship it'):
    path = folder / name
    path.write_text(json.dumps({'job_id': name[:-5], 'goal': goal, 'status': status, 'stages': stages or [],
                                'unknown_field': {'x': 1}}))
    if age:
        old = time.time() - age
        os.utime(path, (old, old))
    return path


def _stage(sid, bot, title, state, attempt=1, **extra):
    return {'id': sid, 'bot': bot, 'title': title, 'state': state, 'attempt': attempt, 'deliveries': [], **extra}


@pytest.fixture
def jobs(tmp_path, monkeypatch):
    folder = tmp_path / 'jobs'
    folder.mkdir()
    monkeypatch.setenv('BOT_DISPATCH_HOME', str(folder))
    return folder


def test_running_and_pending_stages_of_a_running_job_become_rows(jobs):
    _job(jobs, 'job-1.json', stages=[
        _stage('s1', 'research', 'Read the code', 'running', 2),
        _stage('s2', 'coder', 'Write it', 'pending'),
        _stage('s3', 'coder', 'Old work', 'passed'),
        _stage('s4', 'coder', 'Weird', 'frobnicating'),
        _stage('s5', 'coder', 'Accepted already', 'running', accepted=True)])
    rows = hermes_api.dispatch_job_rows()
    assert [(bot, row['title'], row['status']) for bot, row in rows] == [
        ('research', 'Job: Read the code - research - attempt 2', 'started'),
        ('coder', 'Job: Write it - coder - attempt 1', 'queued')]


def test_jobs_that_are_not_running_are_ignored(jobs):
    _job(jobs, 'job-1.json', status='finished', stages=[_stage('s1', 'coder', 'x', 'running')])
    _job(jobs, 'job-2.json', status='cancelled', stages=[_stage('s1', 'coder', 'x', 'pending')])
    assert hermes_api.dispatch_job_rows() == []


def test_missing_directory_and_no_variable_mean_no_rows_and_no_error(activity, tmp_path, monkeypatch):
    monkeypatch.setenv('BOT_DISPATCH_HOME', str(tmp_path / 'nope'))
    assert hermes_api.dispatch_job_rows() == []
    monkeypatch.delenv('BOT_DISPATCH_HOME')
    monkeypatch.setattr(sys.modules['hermes_cli.profiles'], '_get_default_hermes_home', lambda: tmp_path / 'nohome')
    assert hermes_api.dispatch_job_rows() == []


def test_the_default_directory_is_jobs_inside_the_hermes_home(activity, tmp_path, monkeypatch):
    monkeypatch.delenv('BOT_DISPATCH_HOME', raising=False)
    monkeypatch.setattr(sys.modules['hermes_cli.profiles'], '_get_default_hermes_home', lambda: tmp_path)
    (tmp_path / 'jobs').mkdir()
    _job(tmp_path / 'jobs', 'job-1.json', stages=[_stage('s1', 'coder', 'Build', 'running')])
    assert len(hermes_api.dispatch_job_rows()) == 1


def test_bad_files_are_skipped_never_raised(jobs):
    (jobs / 'job-bad.json').write_text('{not json')
    (jobs / 'job-list.json').write_text('[1, 2]')
    (jobs / 'job-stages.json').write_text(json.dumps({'status': 'running', 'stages': 'nope'}))
    (jobs / 'job-junk.json').write_text(json.dumps({'status': 'running', 'stages': [None, 5, {'state': 'running'},
        {'bot': 7, 'title': 'x', 'state': 'running'}, {'bot': 'coder', 'title': ['x'], 'state': 'running', 'attempt': 'many'}]}))
    (jobs / 'job-binary.json').write_bytes(b'\xff\xfe\x00')
    (jobs / 'notes.json').write_text(json.dumps({'status': 'running', 'stages': [_stage('s', 'coder', 'x', 'running')]}))
    _job(jobs, 'job-good.json', stages=[_stage('s1', 'coder', 'Fine', 'running')])
    rows = hermes_api.dispatch_job_rows()
    assert [row['title'] for _, row in rows if row['title'].startswith('Job: Fine')] == ['Job: Fine - coder - attempt 1']
    assert all(bot == 'coder' for bot, _ in rows)


def test_only_the_50_newest_files_are_read_and_big_files_are_skipped(jobs):
    for i in range(55):
        _job(jobs, f'job-{i:03}.json', age=1000 - i, stages=[_stage('s', 'coder', f'T{i:03}', 'running')])
    titles = {row['title'] for _, row in hermes_api.dispatch_job_rows()}
    assert len(titles) == 50 and 'Job: T054 - coder - attempt 1' in titles and 'Job: T000 - coder - attempt 1' not in titles
    for name in jobs.iterdir():
        name.unlink()
    path = _job(jobs, 'job-big.json', stages=[_stage('s', 'coder', 'Huge', 'running')])
    path.write_text(path.read_text() + ' ' * 70000)       # valid JSON, over 64 KB
    assert hermes_api.dispatch_job_rows() == []


def test_a_job_file_nobody_has_touched_for_a_long_time_is_not_live(jobs):
    _job(jobs, 'job-old.json', age=3 * 24 * 3600, stages=[_stage('s', 'coder', 'Ancient', 'running')])
    assert hermes_api.dispatch_job_rows() == []


def test_job_text_is_cleaned_and_cut(jobs):
    _job(jobs, 'job-1.json', stages=[_stage('s', 'coder', 'Evil\u202e\x07 title\n' + 'x' * 500, 'running')])
    (_, row), = hermes_api.dispatch_job_rows()
    assert '\u202e' not in row['title'] and '\x07' not in row['title'] and '\n' not in row['title']
    assert len(row['title']) <= 120


def test_rows_never_carry_briefs_or_replies(jobs):
    _job(jobs, 'job-1.json', stages=[_stage('s', 'coder', 'Build', 'running', brief='SECRET BRIEF', reason='SECRET REASON')])
    assert 'SECRET' not in json.dumps(hermes_api.dispatch_job_rows())


# ---- merging into a bot's activity ----

def test_a_job_row_for_a_bot_with_a_native_row_is_detail_not_a_second_working(activity, jobs):
    home, gw = activity
    _rows(home, (1, 'bot:aaaa', 'started', _payload('TITLE: Read the code')))
    _job(jobs, 'job-1.json', stages=[_stage('s1', 'research', 'Read the code', 'running')])
    result = hermes_api.bot_activity(home, 'research', include_queue=True)
    assert result['queued'] == 0
    native, job = result['queue']
    assert native['status'] == 'started' and not native.get('detail')
    assert job['detail'] is True and job['title'] == 'Job: Read the code - research - attempt 1'
    assert result['state'] == 'working'


def test_a_job_row_for_a_bot_with_no_native_row_is_the_work_and_does_not_change_the_count(activity, jobs):
    home, gw = activity
    _rows(home)
    _job(jobs, 'job-1.json', stages=[_stage('s1', 'research', 'Read the code', 'running')])
    result = hermes_api.bot_activity(home, 'research', include_queue=True)
    assert result['state'] == 'working' and result['queued'] == 0
    assert [(row['status'], row.get('detail', False)) for row in result['queue']] == [('started', False)]


def test_a_pending_job_stage_alone_does_not_make_a_bot_working(activity, jobs):
    home, gw = activity
    _rows(home)
    _job(jobs, 'job-1.json', stages=[_stage('s1', 'research', 'Later', 'pending')])
    result = hermes_api.bot_activity(home, 'research', include_queue=True)
    assert result['state'] == 'idle' and [row['status'] for row in result['queue']] == ['queued']


def test_other_bots_job_rows_stay_out(activity, jobs):
    home, gw = activity
    _rows(home)
    _job(jobs, 'job-1.json', stages=[_stage('s1', 'coder', 'Build', 'running')])
    result = hermes_api.bot_activity(home, 'research', include_queue=True)
    assert result['queue'] == [] and result['state'] == 'idle'


def test_nothing_changes_without_job_files_or_work(activity, jobs):
    home, gw = activity
    _rows(home)
    assert hermes_api.bot_activity(home, 'research', include_queue=True) == {
        'state': 'idle', 'queued': 0, 'queue': [], 'queue_truncated': False}
    assert hermes_api.bot_activity(home, 'research') == {'state': 'idle', 'queued': 0}


def test_activity_without_the_queue_never_reads_job_files(activity, jobs, monkeypatch):
    home, gw = activity
    _rows(home)
    monkeypatch.setattr(hermes_api, 'dispatch_job_rows', lambda **k: (_ for _ in ()).throw(AssertionError('read')))
    assert hermes_api.bot_activity(home, 'research') == {'state': 'idle', 'queued': 0}


def test_a_failing_job_reader_never_breaks_activity(activity, jobs, monkeypatch):
    home, gw = activity
    _rows(home)
    monkeypatch.setattr(hermes_api, 'dispatch_job_rows', lambda **k: (_ for _ in ()).throw(RuntimeError('boom')))
    assert hermes_api.bot_activity(home, 'research', include_queue=True)['state'] == 'idle'


def test_bot_activities_reads_the_directory_once_for_all_bots(activity, jobs, monkeypatch):
    home, gw = activity
    _rows(home)
    gw.profiles = [('research', home), ('coder', home)]
    calls = []
    real = hermes_api.dispatch_job_rows
    monkeypatch.setattr(hermes_api, 'dispatch_job_rows', lambda **k: calls.append(1) or real(**k))
    _job(jobs, 'job-1.json', stages=[_stage('s1', 'coder', 'Build', 'running')])
    result = hermes_api.bot_activities()
    assert len(calls) == 1
    assert len(result['coder']['queue']) == 1 and result['research']['queue'] == []


# ---- review fixes: each test below failed before its fix ----

def _queued(home, n):
    _rows(home, *[(i, f'bot:q{i:03}', 'queued', _payload(f'Queued {i}')) for i in range(1, n + 1)])


def test_finding1_a_running_job_makes_a_bot_with_only_queued_rows_working(activity, jobs):
    home, gw = activity          # the gateway answers active_agents 0
    _queued(home, 1)
    _job(jobs, 'job-1.json', stages=[_stage('s1', 'research', 'Build', 'running')])
    result = hermes_api.bot_activity(home, 'research', include_queue=True)
    assert result['state'] == 'working'
    job = result['queue'][-1]
    assert job['title'].startswith('Job: Build') and not job.get('detail')   # the job is the work, not a detail of a queued row


@pytest.mark.parametrize('count', [49, 50, 60])
def test_finding1_a_running_job_wins_even_when_the_native_queue_is_full(activity, jobs, count):
    home, gw = activity
    _queued(home, count)
    _job(jobs, 'job-1.json', stages=[_stage('s1', 'research', 'Build', 'running')])
    result = hermes_api.bot_activity(home, 'research', include_queue=True)
    assert result['state'] == 'working'
    assert result['queue_truncated'] is (count >= 50)


def test_finding1_with_a_started_native_row_the_job_row_stays_detail(activity, jobs):
    home, gw = activity
    _rows(home, (1, 'bot:aaaa', 'started', _payload('Do it')), (2, 'bot:bbbb', 'queued', _payload('Later')))
    _job(jobs, 'job-1.json', stages=[_stage('s1', 'research', 'Build', 'running')])
    result = hermes_api.bot_activity(home, 'research', include_queue=True)
    assert [bool(row.get('detail')) for row in result['queue']] == [False, False, True]


def test_finding1_a_pending_job_stage_with_a_full_queue_is_still_not_working(activity, jobs):
    home, gw = activity
    _queued(home, 50)
    _job(jobs, 'job-1.json', stages=[_stage('s1', 'research', 'Later', 'pending')])
    assert hermes_api.bot_activity(home, 'research', include_queue=True)['state'] == 'idle'


def test_finding2_a_started_admission_does_not_beat_a_healthy_gateway_saying_nothing_runs(activity):
    home, gw = activity
    gw.reply = {'active_agents': 0}
    _rows(home, (1, 'bot:aaaa', 'started', _payload('Orphaned claim')))
    assert hermes_api.bot_activity(home, 'research')['state'] == 'idle'


def test_finding2_a_started_admission_still_counts_when_the_gateway_is_silent_and_a_busy_gateway_wins(activity):
    home, gw = activity
    _rows(home, (1, 'bot:aaaa', 'started', _payload('Do it')))
    gw.reply = None
    assert hermes_api.bot_activity(home, 'research')['state'] == 'working'
    gw.reply = {'active_agents': 1}
    assert hermes_api.bot_activity(home, 'research')['state'] == 'working'


def test_finding3_a_job_file_untouched_for_three_hours_is_not_live(jobs):
    _job(jobs, 'job-old.json', age=3 * 3600, stages=[_stage('s', 'coder', 'Stale', 'running')])
    assert hermes_api.dispatch_job_rows() == []
    _job(jobs, 'job-new.json', age=3600, stages=[_stage('s', 'coder', 'Fresh', 'running')])
    assert [row['title'] for _, row in hermes_api.dispatch_job_rows()] == ['Job: Fresh - coder - attempt 1']


def test_finding3_a_job_whose_newest_stage_started_long_ago_is_not_live_even_if_the_file_is_fresh(jobs):
    now = time.time()
    _job(jobs, 'job-1.json', stages=[_stage('s1', 'coder', 'Old', 'running', started_at=now - 3 * 3600),
                                     _stage('s2', 'coder', 'Older', 'running', started_at=now - 5 * 3600)])
    _job(jobs, 'job-2.json', stages=[_stage('s1', 'coder', 'Done', 'passed', started_at=now - 5 * 3600),
                                     _stage('s2', 'coder', 'Live', 'running', started_at=now - 60)])
    _job(jobs, 'job-3.json', stages=[_stage('s1', 'coder', 'NoStamp', 'running'),
                                     _stage('s2', 'coder', 'Junk', 'pending', started_at='yesterday')])
    titles = sorted(row['title'] for _, row in hermes_api.dispatch_job_rows())
    assert titles == ['Job: Junk - coder - attempt 1', 'Job: Live - coder - attempt 1', 'Job: NoStamp - coder - attempt 1']


def test_finding4_a_job_gives_at_most_20_rows(jobs):
    _job(jobs, 'job-1.json', stages=[_stage(f's{i}', 'coder', f'T{i:03}', 'running') for i in range(500)])
    rows = hermes_api.dispatch_job_rows()
    assert len(rows) == 20 and rows[0][1]['title'] == 'Job: T000 - coder - attempt 1'
    assert rows[-1][1]['title'] == 'Job: T019 - coder - attempt 1'


def test_finding4_the_stage_cap_counts_only_displayable_stages(jobs):
    _job(jobs, 'job-1.json', stages=[_stage(f'd{i}', 'coder', 'Done', 'passed') for i in range(100)]
         + [_stage(f's{i}', 'coder', f'T{i:03}', 'running') for i in range(30)])
    assert len(hermes_api.dispatch_job_rows()) == 20


def test_finding4_an_unchanged_folder_is_read_once_per_interval_and_a_change_is_seen(jobs, monkeypatch):
    _job(jobs, 'job-1.json', stages=[_stage('s1', 'coder', 'One', 'running')])
    opened = []
    real_open = open
    monkeypatch.setattr('builtins.open', lambda path, *a, **k: opened.append(str(path)) or real_open(path, *a, **k))
    first = hermes_api.dispatch_job_rows()
    second = hermes_api.dispatch_job_rows()
    assert first == second and len([p for p in opened if p.endswith('job-1.json')]) == 1
    second[0][1]['title'] = 'mutated'                      # a caller's edit must not poison the memo
    assert hermes_api.dispatch_job_rows()[0][1]['title'] == 'Job: One - coder - attempt 1'
    _job(jobs, 'job-2.json', stages=[_stage('s1', 'coder', 'Two', 'running')])     # entry count changes
    assert len(hermes_api.dispatch_job_rows()) == 2


def test_finding4_the_memo_expires_after_one_interval(jobs, monkeypatch):
    path = _job(jobs, 'job-1.json', stages=[_stage('s1', 'coder', 'One', 'running')])
    assert len(hermes_api.dispatch_job_rows()) == 1
    path.write_text(json.dumps({'status': 'finished', 'stages': []}))                # in-place edit: dir mtime unchanged
    clock = [time.monotonic()]
    monkeypatch.setattr(hermes_api, '_dispatch_clock', lambda: clock[0] + hermes_api.DISPATCH_CACHE_SECONDS + 1)
    assert hermes_api.dispatch_job_rows() == []


def test_finding5_a_symlinked_job_file_is_not_followed(jobs, tmp_path):
    outside = tmp_path / 'outside.json'
    outside.write_text(json.dumps({'status': 'running', 'stages': [_stage('s', 'coder', 'STOLEN', 'running')]}))
    (jobs / 'job-link.json').symlink_to(outside)
    assert hermes_api.dispatch_job_rows() == []


def test_finding6_a_pending_stage_shows_as_a_queued_row_but_adds_nothing_to_the_count(activity, jobs):
    home, gw = activity
    _rows(home)
    _job(jobs, 'job-1.json', stages=[_stage('s1', 'research', 'Later', 'pending')])
    result = hermes_api.bot_activity(home, 'research', include_queue=True)
    assert result['queued'] == 0 and [row['status'] for row in result['queue']] == ['queued']


def test_docs_describe_the_corrected_rules():
    text = (__import__('pathlib').Path(__file__).resolve().parent.parent / 'docs' / 'BOTS.md').read_text()
    assert 'started hand-off of its own' in text and 'touched in the last day' not in text
    assert 'two hours' in text and 'at most 20' in text and 'waiting count' in text
