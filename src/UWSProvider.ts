/* eslint-disable no-console */
import IORedis from 'ioredis'
import * as crypto from 'crypto'
import uws, { TemplatedApp, WebSocket } from '../uws'
import { UWSSocket } from './UWSSocket'
import { encodePacket } from './util/Converter'
import { ITeckosSocketHandler } from './types/ITeckosSocketHandler'
import { ITeckosProvider } from './types/ITeckosProvider'
import { TeckosOptions } from './types/TeckosOptions'
import { EVENT } from './types/TeckosPacketType'

const DEFAULT_OPTION: TeckosOptions = {
    pingInterval: 25000,
    pingTimeout: 5000,
}

function generateUUID(): string {
    return crypto.randomBytes(16).toString('hex')
}

class UWSProvider implements ITeckosProvider {
    private _app: TemplatedApp

    private readonly _options: TeckosOptions

    private readonly _pub: IORedis.Redis | undefined

    private readonly _sub: IORedis.Redis | undefined

    private _connections: {
        [uuid: string]: UWSSocket
    } = {}

    private _handlers: ITeckosSocketHandler[] = []

    constructor(app: TemplatedApp, options?: TeckosOptions) {
        this._app = app
        this._options = {
            redisUrl: options?.redisUrl || undefined,
            pingInterval: options?.pingInterval || DEFAULT_OPTION.pingInterval,
            pingTimeout: options?.pingInterval || DEFAULT_OPTION.pingTimeout,
            debug: options?.debug,
        }

        const { redisUrl } = this._options
        if (redisUrl) {
            if (this._options.debug) console.log(`Using REDIS at ${redisUrl}`)
            this._pub = new IORedis(redisUrl)
            this._sub = new IORedis(redisUrl)

            this._sub.subscribe('a', (err) => {
                if (err) {
                    console.error(err.message)
                }
            })
            // Since we are only subscribing to a,
            // no further checks are necessary (trusting ioredis here)
            this._sub.on('message', (channel: string, message: Buffer | string) =>
                this._app.publish(channel.substr(2), message)
            )

            this._sub.psubscribe('g.*', (err) => {
                if (err) {
                    console.error(err.message)
                }
            })
            // Since we are only p-subscribing to g.*,
            // no further checks are necessary (trusting ioredis here)
            this._sub.on('pmessage', (_channel, pattern: string, message: Buffer | string) => {
                const group = pattern.substr(2)
                if (this._options.debug)
                    console.log(`Publishing message from REDIS to group ${group}`)
                this._app.publish(group, message)
            })
        }
        this._app.ws('/*', {
            /* Options */
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unsafe-assignment
            compression: uws.SHARED_COMPRESSOR,
            maxPayloadLength: 16 * 1024 * 1024,
            idleTimeout: 0,
            maxBackpressure: 1024,

            open: (ws: WebSocket) => {
                const id: string = generateUUID()
                /* Let this client listen to all sensor topics */

                // Subscribe to all
                ws.subscribe('a')

                // eslint-disable-next-line no-param-reassign
                ws.id = id
                // eslint-disable-next-line no-param-reassign
                ws.alive = true
                this._connections[id] = new UWSSocket(id, ws, options?.debug)
                try {
                    this._handlers.forEach((handler) => {
                        handler(this._connections[id])
                    })
                } catch (handlerError) {
                    console.error(handlerError)
                }
            },
            pong: (ws) => {
                // eslint-disable-next-line no-param-reassign
                ws.alive = true
            },
            message: (ws: WebSocket, buffer: ArrayBuffer) => {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                const id = ws.id as string
                if (this._connections[id]) {
                    this._connections[id].onMessage(buffer)
                } else {
                    console.error(`Got message from unknown connection: ${id}`)
                }
            },
            drain: (ws: WebSocket) => {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                const id = ws.id as string
                if (options?.debug) console.log(`Drain: ${id}`)
            },
            close: (ws: WebSocket) => {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                const id = ws.id as string
                if (this._connections[id]) {
                    if (this._options.debug) {
                        console.log(`Client ${id} disconnected, removing from registry`)
                    }
                    this._connections[id].onDisconnect()
                    delete this._connections[id]
                }
            },
        })

        // Add ping
        this._keepAliveSockets()
    }

    private _keepAliveSockets = () => {
        setTimeout(
            (connections: { [uuid: string]: UWSSocket }) => {
                Object.keys(connections).forEach((uuid) => {
                    const ws = this._connections[uuid].ws()
                    if (ws.alive) {
                        ws.alive = false
                        ws.ping('hey')
                    } else {
                        // Terminate connection
                        if (this._options.debug)
                            console.log(`Ping pong timeout for ${uuid}, disconnecting client...`)
                        this._connections[uuid].disconnect()
                    }
                })
                this._keepAliveSockets()
            },
            this._options.pingInterval,
            this._connections
        )
    }

    onConnection = (handler: ITeckosSocketHandler): this => {
        this._handlers.push(handler)
        return this
    }

    toAll = (event: string, ...args: any[]): this => {
        args.unshift(event)
        const buffer = encodePacket({
            type: EVENT,
            data: args,
        })
        if (this._pub) {
            this._pub.publishBuffer('a', buffer).catch((err) => console.error(err))
        } else {
            if (this._options.debug) console.log(`Publishing event ${event} to group a`)
            this._app.publish('a', buffer)
        }
        return this
    }

    to = (group: string, event: string, ...args: any[]): this => {
        args.unshift(event)
        const buffer = encodePacket({
            type: EVENT,
            data: args,
        })
        if (this._pub) {
            this._pub.publishBuffer(`g.${group}`, buffer).catch((err) => console.error(err))
        } else {
            if (this._options.debug) console.log(`Publishing event ${event} to group ${group}`)
            this._app.publish(group, buffer)
        }
        return this
    }

    listen = (port: number): Promise<any> =>
        new Promise((resolve, reject) => {
            this._app.listen(port, (socket) => {
                if (socket) {
                    return resolve(this)
                }
                return reject(new Error(`Could not listen on port ${port}`))
            })
        })
}

export { UWSProvider }
