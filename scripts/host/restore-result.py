#!/usr/bin/env python3
"""Validate the sanitized output of an isolated database restore."""
import hashlib
import json
from pathlib import Path
import re
import sys


def section(text, name):
    begin, end = 'BEGIN_' + name, 'END_' + name
    lines = text.splitlines()
    if lines.count(begin) != 1 or lines.count(end) != 1:
        raise ValueError('Missing or repeated section: ' + name)
    first, last = lines.index(begin), lines.index(end)
    if last <= first + 1:
        raise ValueError('Empty or reversed section: ' + name)
    return lines[first + 1:last]


def counts(lines):
    result = {}
    for line in lines:
        if not re.fullmatch(r'[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\|[0-9]+', line):
            raise ValueError('Invalid table count')
        name, value = line.split('|')
        if name in result:
            raise ValueError('Repeated table count')
        result[name] = int(value)
    if not result:
        raise ValueError('No table counts')
    return result


def validate(postgres, redis):
    for marker in ['postgres_full_restore=passed', 'copy_payload_match=passed']:
        if postgres.splitlines().count(marker) != 1:
            raise ValueError('Missing or repeated PostgreSQL completion marker')
    restored = counts(section(postgres, 'COUNTS'))
    if restored != counts(section(postgres, 'ARCHIVE_COUNTS')):
        raise ValueError('Archive row counts differ')
    role_lines = section(postgres, 'ROLES')
    if len(role_lines) != 1 or not re.fullmatch(r'[0-9a-f]{64}  -', role_lines[0]):
        raise ValueError('Expected a role digest only')
    section(postgres, 'OWNERSHIP')
    if 'SCRAM-SHA-256$' in postgres or re.search(r'\bmd5[0-9a-f]{32}\b', postgres):
        raise ValueError('Credential hashes must not enter the result')
    if redis.splitlines().count('redis_full_load=passed') != 1:
        raise ValueError('Missing or repeated Redis completion marker')
    metrics = {}
    for name in ['source_rdb_keys', 'loaded_keys', 'expired_at_load']:
        values = re.findall(r'^' + name + r'=([0-9]+)$', redis, re.M)
        if len(values) != 1:
            raise ValueError('Missing or repeated Redis count')
        metrics[name] = int(values[0])
    if metrics['loaded_keys'] + metrics['expired_at_load'] != metrics['source_rdb_keys']:
        raise ValueError('Redis key count differs')
    return {'passed': True, 'tables': restored, 'redis': metrics,
            'copyPayloadMatch': True, 'rolesRestored': True}


def main():
    work = Path(sys.argv[1])
    result = validate((work / 'postgres-result.txt').read_text(), (work / 'redis-result.txt').read_text())
    result['sourceMatches'] = {}
    postgres = (work / 'postgres-result.txt').read_text()
    for name in ['counts', 'ownership', 'roles']:
        source = (work / ('source-' + name + '.tsv')).read_text().splitlines()
        result['sourceMatches'][name] = source == section(postgres, name.upper())
    result['inputChecksums'] = (work / 'input-sha256.txt').read_text().splitlines()
    result['images'] = (work / 'images.txt').read_text().splitlines()
    result['startedAt'] = (work / 'started-at.txt').read_text().strip()
    from datetime import datetime, timezone
    result['finishedAt'] = datetime.now(timezone.utc).isoformat()
    # Only aggregate counts, booleans and input checksums leave the scratch outputs.
    with (work / 'result.json').open('x') as output:
        json.dump(result, output, indent=2)
        output.write('\n')


if __name__ == '__main__':
    main()
