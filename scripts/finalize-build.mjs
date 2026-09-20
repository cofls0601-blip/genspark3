import { cp, mkdir } from 'node:fs/promises'

await mkdir('dist/.openai', { recursive: true })
await cp('.openai/hosting.json', 'dist/.openai/hosting.json')
