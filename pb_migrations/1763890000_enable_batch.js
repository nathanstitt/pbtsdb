/// <reference path="../pb_data/types.d.ts" />
migrate(
    app => {
        const settings = app.settings()
        settings.batch.enabled = true
        settings.batch.maxRequests = 20
        settings.batch.timeout = 10
        app.save(settings)
    },
    app => {
        const settings = app.settings()
        settings.batch.enabled = false
        app.save(settings)
    }
)
