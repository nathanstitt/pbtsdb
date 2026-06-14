// Polyfill EventSource for PocketBase real-time subscriptions in Node.js tests
import { EventSource } from 'eventsource'

// Add EventSource to global scope
global.EventSource = EventSource as unknown as typeof globalThis.EventSource
