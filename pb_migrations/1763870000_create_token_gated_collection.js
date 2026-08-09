/// <reference path="../pb_data/types.d.ts" />
migrate(
    app => {
        // Read access is gated solely on a custom header so that realtime
        // subscription options can be verified end-to-end. Writes stay
        // auth-gated so tests can seed rows as the regular test user.
        const tokenGatedCollection = new Collection({
            name: 'token_gated',
            type: 'base',
            system: false,
            fields: [
                {
                    id: 'text3208210256',
                    name: 'id',
                    type: 'text',
                    required: true,
                    presentable: false,
                    unique: false,
                    system: true,
                    primaryKey: true,
                    autogeneratePattern: '[a-z0-9]{15}',
                    hidden: false,
                    pattern: '^[a-z0-9]+$',
                    min: 15,
                    max: 15
                },
                {
                    id: 'text7412589630',
                    name: 'title',
                    type: 'text',
                    required: true,
                    presentable: false,
                    unique: false,
                    system: false,
                    hidden: false,
                    autogeneratePattern: '',
                    pattern: '',
                    min: 1,
                    max: 255
                },
                {
                    id: 'autodate2990389176',
                    name: 'created',
                    type: 'autodate',
                    required: false,
                    presentable: false,
                    unique: false,
                    system: false,
                    hidden: false,
                    onCreate: true,
                    onUpdate: false
                },
                {
                    id: 'autodate3332085495',
                    name: 'updated',
                    type: 'autodate',
                    required: false,
                    presentable: false,
                    unique: false,
                    system: false,
                    hidden: false,
                    onCreate: true,
                    onUpdate: true
                }
            ],
            indexes: [],
            listRule: '@request.headers.x_test_token = "let-me-in"',
            viewRule: '@request.headers.x_test_token = "let-me-in"',
            createRule: "@request.auth.id != ''",
            updateRule: "@request.auth.id != ''",
            deleteRule: "@request.auth.id != ''"
        });

        app.save(tokenGatedCollection);
    },
    app => {
        const tokenGated = app.findCollectionByNameOrId('token_gated');
        if (tokenGated) {
            return app.delete(tokenGated);
        }
    }
);
