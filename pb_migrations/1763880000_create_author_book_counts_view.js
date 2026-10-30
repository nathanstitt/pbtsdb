/// <reference path="../pb_data/types.d.ts" />
// A view for liveTopics tests: PocketBase sends no record events for a view,
// so only a topic message can tell a client that a count changed.
migrate(
    app => {
        const view = new Collection({
            name: 'author_book_counts',
            type: 'view',
            listRule: "@request.auth.id != ''",
            viewRule: "@request.auth.id != ''",
            viewQuery: `SELECT a.id, a.name, COUNT(b.id) AS book_count
                FROM authors a LEFT JOIN books b ON b.author = a.id
                GROUP BY a.id`,
        })
        app.save(view)
    },
    app => {
        app.delete(app.findCollectionByNameOrId('author_book_counts'))
    }
)
