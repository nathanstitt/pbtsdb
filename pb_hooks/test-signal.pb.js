// Test fixture: sends `count` data-free messages on `topic` to every
// signed-in realtime client subscribed to it, the way tinycld core's
// changesignal package does after a write. The payload is '{}': pbtsdb drops
// an event whose data is not JSON.
routerAdd(
    'POST',
    '/api/test/signal',
    e => {
        const body = e.requestInfo().body
        const topic = String(body.topic || '')
        const count = Number(body.count || 1)
        const clients = $app.subscriptionsBroker().clients()
        for (let i = 0; i < count; i++) {
            for (const id in clients) {
                const client = clients[id]
                if (client.hasSubscription(topic) && client.get('auth')) {
                    client.send(new SubscriptionMessage({ name: topic, data: '{}' }))
                }
            }
        }
        return e.noContent(204)
    },
    $apis.requireAuth()
)
