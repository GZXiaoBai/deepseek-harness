/** Records the configuration that the real Loader delivers to the preset row. */
import { writeFileSync } from 'node:fs'

export const name = 'preset-config-recorder'

export function apply(_ctx, config) {
  writeFileSync(config.record, JSON.stringify(config))
}
