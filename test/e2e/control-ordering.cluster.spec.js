import { test } from '@playwright/test'
import { assertSafeE2ETarget } from '../../scripts/test-target.mjs'
import { controlOrderingTests } from './control-ordering-helpers.js'

if (process.env.INSTANCE_B) assertSafeE2ETarget(process.env.INSTANCE_B)
test.skip(!process.env.INSTANCE_B, 'requires a second replica')
controlOrderingTests({ cluster: true })
