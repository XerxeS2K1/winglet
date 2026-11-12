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
    assert result['queued'] == 0 or result['queued'] is not None
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
