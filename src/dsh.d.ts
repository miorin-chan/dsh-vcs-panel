/**
 * The DSH declarations this plugin types against.
 *
 * Each package augments `@deepseek-ai/cordis` with the service it registers;
 * importing it once here puts every service this plugin reaches on `Context`
 * for the whole program. The imports are type-only, so this file produces no
 * runtime code and the artifacts keep zero `@deepseek-ai/*` runtime imports.
 */

/** Host services: authenticated routes, sessions, backend execution, filesystem. */
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'

/** Client services: each browser half declares its service from the package's `./client` entry. */
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-shortcuts/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
