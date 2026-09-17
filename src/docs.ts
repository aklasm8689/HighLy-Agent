export const openApiSpec = {
  openapi: '3.0.0',
  info: {
    title: 'HighLyAgent API',
    description: 'API documentation for HighLyAgent backend and management endpoints.',
    version: '1.0.0'
  },
  components: {
    securitySchemes: {
      ManagementToken: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT'
      },
      ManagementApiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'x-management-api-key'
      },
      ClientApiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key'
      },
      ClientProjectId: {
        type: 'apiKey',
        in: 'header',
        name: 'x-project-id'
      }
    }
  },
  paths: {
    '/health': {
      get: {
        summary: 'System health check',
        responses: {
          '200': { description: 'Health status' }
        }
      }
    },
    '/api/v1/auth/login': {
      post: {
        summary: 'Login to Management Dashboard',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  email: { type: 'string' },
                  password: { type: 'string' }
                }
              }
            }
          }
        },
        responses: {
          '200': { description: 'Successful login' }
        }
      }
    },
    '/api/v1/projects': {
      get: {
        summary: 'List all projects',
        security: [{ ManagementToken: [] }, { ManagementApiKey: [] }],
        responses: {
          '200': { description: 'List of projects' }
        }
      }
    },
    '/api/v1/agent/chat': {
      post: {
        summary: 'Chat with the AI Agent',
        security: [{ ClientApiKey: [], ClientProjectId: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  query: { type: 'string' },
                  user_id: { type: 'string' }
                }
              }
            }
          }
        },
        responses: {
          '200': { description: 'Agent response' }
        }
      }
    }
  }
};
