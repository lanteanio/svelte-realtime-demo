import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('restore_result', Path(__file__).resolve().parents[2] / 'scripts/host/restore-result.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

POSTGRES = '\n'.join([
    'BEGIN_COUNTS', 'public.notes|2', 'END_COUNTS',
    'BEGIN_ARCHIVE_COUNTS', 'public.notes|2', 'END_ARCHIVE_COUNTS',
    'BEGIN_OWNERSHIP', 'database||demo|owner|NULL', 'END_OWNERSHIP',
    'BEGIN_ROLES', 'a' * 64 + '  -', 'END_ROLES',
    'copy_payload_match=passed', 'postgres_full_restore=passed'])
REDIS = 'source_rdb_keys=3\nloaded_keys=2\nexpired_at_load=1\nredis_full_load=passed\n'

class RestoreResultTests(unittest.TestCase):
    def test_matching_restore(self):
        result = module.validate(POSTGRES, REDIS)
        self.assertTrue(result['passed'])
        self.assertEqual(result['tables'], {'public.notes': 2})
        self.assertEqual(result['redis']['expired_at_load'], 1)

    def test_invalid_postgres_fails_closed(self):
        for bad in [
            POSTGRES.replace('postgres_full_restore=passed', ''),
            POSTGRES + '\npostgres_full_restore=passed',
            POSTGRES.replace('copy_payload_match=passed', ''),
            POSTGRES.replace('BEGIN_ROLES', 'BEGIN_WRONG'),
            POSTGRES.replace('a' * 64 + '  -', 'SCRAM-SHA-256$example'),
            POSTGRES.replace('BEGIN_COUNTS\npublic.notes|2', 'BEGIN_COUNTS'),
            POSTGRES.replace('BEGIN_COUNTS\npublic.notes|2', 'BEGIN_COUNTS\npublic.notes|3'),
            POSTGRES.replace('BEGIN_COUNTS\npublic.notes|2', 'BEGIN_COUNTS\npublic.notes|2\npublic.notes|2'),
            POSTGRES.replace('BEGIN_COUNTS\npublic.notes|2', 'BEGIN_COUNTS\npublic.notes|-2'),
            POSTGRES.replace('END_ROLES', 'END_ROLES\nEND_ROLES')
        ]:
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError): module.validate(bad, REDIS)

    def test_invalid_redis_fails_closed(self):
        for bad in [REDIS.replace('source_rdb_keys=3', 'source_rdb_keys=4'),
                    REDIS.replace('loaded_keys=2', ''),
                    REDIS + 'loaded_keys=2\n', REDIS.replace('redis_full_load=passed', ''),
                    REDIS.replace('expired_at_load=1', 'expired_at_load=-1')]:
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError): module.validate(POSTGRES, bad)

if __name__ == '__main__': unittest.main()
