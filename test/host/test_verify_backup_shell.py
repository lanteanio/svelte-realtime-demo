import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = (ROOT / 'scripts/host/verify-backup.sh').read_text()
BASH = str(Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'Git/bin/bash.exe') if os.name == 'nt' else shutil.which('bash')


def between(start, end):
    return SCRIPT.split(start, 1)[1].split(end, 1)[0]


class BackupShellTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.directory = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def run_shell(self, code, *args):
        env = dict(os.environ, FIXTURE=self.directory.as_posix())
        if os.name == 'nt': env['MSYS'] = 'winsymlinks:sys'
        return subprocess.run([BASH, '-s', '--', *args], input='set -euo pipefail\n' + code,
                              text=True, capture_output=True, env=env)

    def test_copy_count_parser(self):
        code = "awk '\n /^COPY" + between("awk '\n /^COPY", "' /tmp/source-data.sql") + "' \"$FIXTURE/dump.sql\""
        good = 'COPY public.notes (id) FROM stdin;\n1\n2\n\\.\n'
        cases = [(good, True, 'public.notes|2\n'),
                 (good.replace('public.notes', '"public"."notes"'), True, 'public.notes|2\n'),
                 (good + 'COPY public.other (id) FROM stdin;\nx\n', False, ''),
                 ('COPY public.notes (id) FROM stdin;\n\\.\n', True, 'public.notes|0\n'),
                 (good + 'COPY public.other (id) FROM stdin;\nx\n\\.\n', True, 'public.notes|2\npublic.other|1\n'),
                 ('-- no table\n', False, ''),
                 ('COPY public.notes (id) FROM stdin;\n1\n', False, ''),
                 ('COPY public.notes (id) FROM stdin;\nCOPY public.other (id) FROM stdin;\n\\.\n', False, ''),
                 ('COPY public.bad-name (id) FROM stdin;\n1\n\\.\n', False, '')]
        for dump, valid, output in cases:
            with self.subTest(dump=dump):
                (self.directory / 'dump.sql').write_text(dump)
                result = self.run_shell(code)
                self.assertEqual(result.returncode == 0, valid, result.stderr)
                if valid: self.assertEqual(result.stdout, output)

    def test_copy_payload_comparison(self):
        code = 'for item in source restored; do' + between('for item in source restored; do', "printf 'copy_payload_match=passed")
        code = code.replace('/tmp/', '"$FIXTURE"/')
        good = 'COPY public.notes (id) FROM stdin;\n1\n2\n\\.\n'
        (self.directory / 'source-data.sql').write_text('-- archive comment\n' + good)
        for restored, valid in [('-- other comment\n' + good, True),
                                (good.replace('\n2\n', '\n3\n'), False),
                                (good.replace('\n2\n', ''), False)]:
            with self.subTest(restored=restored):
                (self.directory / 'restored-data.sql').write_text(restored)
                result = self.run_shell(code)
                self.assertEqual(result.returncode == 0, valid, result.stderr)

    def test_section_extraction_and_archive_comparison(self):
        code = 'for section in COUNTS OWNERSHIP ROLES ARCHIVE_COUNTS; do' + between(
            'for section in COUNTS OWNERSHIP ROLES ARCHIVE_COUNTS; do', "printf 'archive_row_counts_match=passed")
        good = 'BEGIN_COUNTS\npublic.notes|2\nEND_COUNTS\nBEGIN_OWNERSHIP\nowner\nEND_OWNERSHIP\nBEGIN_ROLES\ndigest\nEND_ROLES\nBEGIN_ARCHIVE_COUNTS\npublic.notes|2\nEND_ARCHIVE_COUNTS\n'
        for content, valid in [(good, True), (good.replace('BEGIN_ARCHIVE_COUNTS\npublic.notes|2', 'BEGIN_ARCHIVE_COUNTS\npublic.notes|3'), False)]:
            (self.directory / 'postgres-result.txt').write_text(content)
            result = self.run_shell('work="$FIXTURE"\n' + code)
            self.assertEqual(result.returncode == 0, valid, result.stderr)
            if valid:
                self.assertEqual((self.directory / 'restored-OWNERSHIP.tsv').read_text(), 'owner\n')
                self.assertEqual((self.directory / 'restored-ROLES.tsv').read_text(), 'digest\n')

    def test_argument_validation(self):
        code = between('\nscript_dir=', 'mkdir -m 700').split('\n', 1)[1]
        # Convert Windows test paths to the absolute spelling realpath emits in Bash.
        setup = 'fixture=$(cd "$FIXTURE" && pwd)\n'
        for name in ['database.dump', 'roles.sql', 'redis.rdb', 'configuration.tgz']:
            (self.directory / name).write_text('fixture')
        valid = self.run_shell(setup + 'set -- "$fixture" "$fixture/result"\n' + code)
        self.assertEqual(valid.returncode, 0, valid.stderr)
        (self.directory / 'result').mkdir()
        cases = ['set --', 'set -- relative /unused-result',
                 'set -- "$fixture" "$fixture/unused" extra',
                 'set -- "$fixture/." "$fixture/unused"',
                 'set -- "$fixture" "$fixture/result"',
                 'set -- "$fixture" relative',
                 'set -- "$fixture" "$fixture/a,b"',
                 'set -- \"$fixture\" \"$fixture/a\nname\"']
        for setup_case in cases:
            with self.subTest(case=setup_case):
                result = self.run_shell(setup + setup_case + '\n' + code)
                self.assertNotEqual(result.returncode, 0, result.stdout)

    def test_backup_paths_cannot_change_mount_options(self):
        code = between('\nscript_dir=', 'mkdir -m 700').split('\n', 1)[1]
        for name in ['normal', 'b,ro', 'b\nro']:
            with self.subTest(name=name):
                if os.name == 'nt' and '\n' in name:
                    self.skipTest('Win32 forbids newline filenames; the Linux CI run exercises this case')
                backup = self.directory / name
                backup.mkdir()
                for file in ['database.dump', 'roles.sql', 'redis.rdb', 'configuration.tgz']:
                    (backup / file).write_text('fixture')
                setup = 'fixture=$(cd "$FIXTURE" && pwd)\nset -- "$fixture/' + name + '" "$fixture/result"\n'
                result = self.run_shell(setup + code)
                self.assertEqual(result.returncode == 0, name == 'normal', result.stderr)

    def test_every_backup_input_must_be_a_regular_file(self):
        code = between('\nscript_dir=', 'mkdir -m 700').split('\n', 1)[1]
        names = ['database.dump', 'roles.sql', 'redis.rdb', 'configuration.tgz']
        for name in names:
            (self.directory / name).write_text('fixture')
        setup = 'fixture=$(cd "$FIXTURE" && pwd)\nset -- "$fixture" "$fixture/result"\n'
        for name in names:
            file = self.directory / name
            file.unlink()
            with self.subTest(name=name, kind='missing'):
                self.assertNotEqual(self.run_shell(setup + code).returncode, 0)
            file.mkdir()
            with self.subTest(name=name, kind='directory'):
                self.assertNotEqual(self.run_shell(setup + code).returncode, 0)
            file.rmdir()
            file.write_text('fixture')

    def test_backup_symlinks_are_rejected(self):
        code = between('\nscript_dir=', 'mkdir -m 700').split('\n', 1)[1]
        for name in ['database.dump', 'roles.sql', 'redis.rdb', 'configuration.tgz']:
            (self.directory / name).write_text('fixture')
        setup = 'fixture=$(cd "$FIXTURE" && pwd)\n'
        link = self.run_shell(setup + 'ln -s "$fixture" "$fixture/alias"\ntest -L "$fixture/alias"')
        self.assertEqual(link.returncode, 0, link.stderr)
        result = self.run_shell(setup + 'set -- "$fixture/alias" "$fixture/result"\n' + code)
        self.assertNotEqual(result.returncode, 0)
        for name in ['database.dump', 'roles.sql', 'redis.rdb', 'configuration.tgz']:
            with self.subTest(name=name):
                link = self.run_shell(setup + f'mv "$fixture/{name}" "$fixture/original"\nln -s "$fixture/original" "$fixture/{name}"\ntest -L "$fixture/{name}"')
                self.assertEqual(link.returncode, 0, link.stderr)
                result = self.run_shell(setup + 'set -- "$fixture" "$fixture/result"\n' + code)
                self.assertNotEqual(result.returncode, 0)
                restored = self.run_shell(setup + f'rm "$fixture/{name}"\nmv "$fixture/original" "$fixture/{name}"')
                self.assertEqual(restored.returncode, 0, restored.stderr)

    def test_both_healthy_container_gates(self):
        start = 'for id in "$pg_id" "$redis_id"; do'
        blocks = SCRIPT.split(start)[1:]
        self.assertEqual(len(blocks), 2)
        for block in blocks:
            code = start + block.split('\ndone', 1)[0] + '\ndone\nprintf reached'
            for bad_id in ['none', 'pg', 'redis']:
                for state in ['false healthy', 'true unhealthy', 'true starting']:
                    stub = 'pg_id=pg\nredis_id=redis\ndocker() { if [ "${@: -1}" = "' + bad_id + '" ]; then printf "%s" "' + state + '"; else printf "true healthy"; fi; }\n'
                    result = self.run_shell(stub + code)
                    self.assertEqual(result.returncode == 0, bad_id == 'none', result.stderr)
                    self.assertEqual('reached' in result.stdout, bad_id == 'none')

    def test_source_reads_select_the_base_compose_file(self):
        identity = 'pg_id=' + between('pg_id=', 'for name in database.dump roles.sql redis.rdb configuration.tgz; do sha256sum')
        queries = 'for query in counts ownership roles; do' + between(
            'for query in counts ownership roles; do', "printf 'started_at='")
        for name in ['counts', 'ownership', 'roles']:
            (self.directory / (name + '.sql')).write_text('SELECT 1;')
        stub = '''
work="$FIXTURE"
export COMPOSE_FILE=ambient.yml COMPOSE_PROJECT_NAME=maintenance-test
docker() {
  if [ "$1" = compose ]; then
    printf '%s\\t' "$@" >> "$FIXTURE/commands.log"
    printf '\\n' >> "$FIXTURE/commands.log"
    case " $* " in
      *" ps "*) printf '%064d\\n' 1;;
      *'printf "%s" "$POSTGRES_DB"'*) printf 'stickynotes';;
      *" exec "*) printf 'source-result\\n';;
      *) return 2;;
    esac
  elif [ "$1" = inspect ]; then
    case "$3" in
      '{{.Image}}') printf 'sha256:%064d\\n' 2;;
      *) printf 'true healthy\\n';;
    esac
  else
    return 3
  fi
}
'''
        result = self.run_shell(stub + identity + queries)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = [line.split('\t') for line in (self.directory / 'commands.log').read_text().splitlines()]
        self.assertEqual(len(calls), 6)
        for args in calls:
            self.assertEqual(args[:3], ['compose', '-f', 'docker-compose.yml'], args)
        self.assertEqual([args[3] for args in calls], ['ps', 'ps', 'exec', 'exec', 'exec', 'exec'])


if __name__ == '__main__':
    unittest.main()
