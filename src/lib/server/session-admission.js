export const SESSION_CAPACITY = 10000
export const SESSION_ISSUANCE_PER_MINUTE = 600

// Session hashes and their capacity reservations are created atomically.
// Redis time gives every replica the same issuance window and expiry clock.
export const CREATE_SESSION = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[1]) then return 0 end
local window = math.floor(now / 60000)
local previous = tonumber(redis.call('HGET', KEYS[3], 'window') or '-1')
local count = tonumber(redis.call('HGET', KEYS[3], 'count') or '0')
if previous == window and count >= tonumber(ARGV[2]) then return 0 end
if previous ~= window then count = 0 end
redis.call('HSET', KEYS[3], 'window', window, 'count', count + 1)
redis.call('EXPIRE', KEYS[3], 120)
redis.call('HSET', KEYS[1], 'id', ARGV[5], 'name', ARGV[6], 'color', ARGV[7], 'org', ARGV[8])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[3]) * 1000, ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1
`

export const REFRESH_SESSION = `
local values = redis.call('HGETALL', KEYS[1])
if #values == 0 then return values end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if not redis.call('ZSCORE', KEYS[2], ARGV[2]) and redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[3]) then return {} end
redis.call('EXPIRE', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[1]) * 1000, ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[1])
return values
`
