// Pin the time zone for every test process, on every platform: due days are
// local calendar days, and the fixtures were recorded in Asia/Shanghai.
process.env.TZ = 'Asia/Shanghai'
