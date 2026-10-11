import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
function check(record, code = '0') {
  return spawnSync(bash, ['-c', 'df() { printf "%s\\n" "$DF_RECORD"; return "$DF_CODE"; }; export -f df; exec bash scripts/host/check-disk-capacity.sh /'], {
    encoding: 'utf8', env: { ...process.env, DF_RECORD: record, DF_CODE: code }
  })
}

test('disk thresholds include percentage boundaries and exclude free-space boundaries', () => {
  for (const [used, free, expected] of [
    [74, 20 * 1024 ** 3, 0], [75, 20 * 1024 ** 3, 1],
    [10, 20 * 1024 ** 3 - 1, 1], [89, 5 * 1024 ** 3, 1],
    [90, 20 * 1024 ** 3, 2], [10, 5 * 1024 ** 3 - 1, 2]
  ]) {
    const result = check(`Use% Avail\n${used}% ${free}`)
    assert.equal(result.status, expected, result.stderr)
    assert.match(result.stdout, new RegExp(`status=${['normal', 'planning', 'urgent'][expected]}`))
  }
})

test('failed or ambiguous df output never reports a valid capacity sample', () => {
  for (const [record, code] of [
    ['Use% Avail\n1% 99999999999', '1'], ['Use% Avail', '0'],
    ['Use% Avail\n1% 99999999999 extra', '0'], ['Use% Avail\n1% 99999999999\n2% 88888888888', '0'],
    ['Use% Avail\nno unknown', '0'], ['Use% Avail\n1% 999999999999999999999', '0']
  ]) {
    const result = check(record, code)
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stdout, /status=/)
  }
})
