const tedious = require('tedious');
const logger = {};

class ConnectionPool
{
    constructor(poolConfig, connectionConfig)
    {
        this.config = {pool: poolConfig, connection: connectionConfig};
        this.config.pool.min = this.config.pool.min !== undefined ? this.config.pool.min : 1;
        this.config.pool.max = this.config.pool.max !== undefined ? this.config.pool.max : 10;
        this.config.pool.idleTimeout = this.config.pool.idleTimeout !== undefined ? this.config.pool.idleTimeout : 30000;
        this.config.pool.acquireTimeout = this.config.pool.acquireTimeout !== undefined ? this.config.pool.acquireTimeout : 60000;
        this.config.pool.log = this.config.pool.log || false;

        if(typeof this.config.pool.log === 'function')
        {
            logger.log = this.config.pool.log;
        }

        else if(this.config.pool.log)
        {
            logger.log = (...args) => console.log(...args);
        }

        else
        {
            logger.log = () => {};
        }
        
        this.clientID = 0;
        this.connectionID = 0;
        this.waitingClients = [];
        this.connections = [];
        this.connectionRequests = 0;
        this.drained = false;
        this.connect();
    }

    acquire(callback)
    {
        return new Promise((resolve, reject) =>
        {
            callback = typeof callback === 'function' ? callback : () => {};
            let resolved = false;
            const client = {};

            const callbackFn = (error, connection) =>
            {
                if(!resolved)
                {
                    logger.log('debug', `Responding to client: ${client.id} (waiting clients: ${this.waitingClients.length})`);
                    resolved = true;
    
                    if(error)
                    {
                        logger.log('error', error.message);
                        callback(error);
                        return reject(error);
                    }
    
                    callback(null, connection);
                    return resolve(connection);
                }
            };

            const timerFn = () =>
            {
                const error = new Error(`Unable to acquire connection from pool in ${this.config.pool.acquireTimeout}ms.`);
                clearTimeout(client.timerID);
                client.callback(error);

                for(let i = this.waitingClients.length-1; i >= 0; i--)
                {
                    if(this.waitingClients[i].id === client.id)
                    {
                        this.waitingClients.splice(i, 1);
                        break;
                    }
                }
            };
            
            client.id = ++this.clientID;
            client.timerID = setTimeout(timerFn, this.config.pool.acquireTimeout);
            client.callback = callbackFn;
            this.waitingClients.push(client);
            logger.log('debug', `Added new client: ${client.id} (waiting clients: ${this.waitingClients.length})`);
            this.respond();
        })
    }

    connect()
    {
        logger.log('debug', `Refilling connection pool (pool size: ${this.connections.length})`);

        if(this.connections.length < this.config.pool.min)
        {
            const needed = this.config.pool.min - this.connections.length;
            
            for(let i=0; i < needed; i++)
            {
                this.openConnection();
            }
        }
    }

    handleError(error, connection)
    {
        logger.log('error', error.message);
        connection.close();
    }

    addConnection(connection)
    {
        logger.log('debug', `Opened connection: ${connection.meta.id} (pool size: ${this.connections.length})`);
        this.connectionRequests--;
        this.connections.push(connection);
        this.respond();
    }

    prepareConnection(connection)
    {
        connection.meta = {};
        connection.meta.id = ++this.connectionID;
        connection.meta.timestamp = new Date();
        connection.meta.available = true;
        connection.meta.timerID = setTimeout(() => this.removeConnection(connection, true), this.config.pool.idleTimeout);

        connection.once('connect', () => this.addConnection(connection));
        connection.once('error', (error) => this.handleError(error, connection));
        connection.once('infoMessage', (info) => logger.log('info', `Error: ${info.number}. State: ${info.state}. Class: ${info.class}. Message: ${info.message}. Procedure: ${info.procedure}. Line Number: ${info.lineNumber}`));
        connection.once('errorMessage', (error) => logger.log('error', `Error: ${error.number}. State: ${error.state}. Class: ${error.class}. Message: ${error.message}. Procedure: ${error.procedure}. Line Number: ${error.lineNumber}`));
        connection.once('end', () => this.removeConnection(connection));
        connection.release = () =>
        {
            connection.meta.timestamp = new Date();
            connection.meta.available = true;
            connection.meta.timerID = setTimeout(() => this.removeConnection(connection, true), this.config.pool.idleTimeout);
            this.respond();
        };
    }

    openConnection()
    {
        if(this.connectionRequests + this.connections.length < this.config.pool.max)
        {
            this.connectionRequests++;
            const connection = new tedious.Connection(this.config.connection);
            this.prepareConnection(connection);
        }
    }

    removeConnection(connection, checkTimestamp)
    {
        let proceed = false;
        let found = false;

        for(let i=0; i < this.connections.length; i++)
        {
            if(this.connections[i].meta.id === connection.meta.id)
            {
                found = true;
                break;
            }
        }

        if(!found)
        {
            this.connectionRequests--;
        }

        if(!checkTimestamp)
        {
            logger.log('debug', `Closed connection: ${connection.meta.id} (pool size: ${this.connections.length})`);
            proceed = true;
        }

        else if(new Date() - connection.meta.timestamp >= this.config.pool.idleTimeout && connection.meta.available && this.connections.length > this.config.pool.min)
        {
            logger.log('debug', `Closed stale connection: ${connection.meta.id} (pool size: ${this.connections.length})`);
            proceed = true;
        }

        if(proceed)
        {
            ['connect', 'error', 'errorMessage', 'infoMessage'].forEach((eventName) => connection.removeAllListeners(eventName));
            
            for(let i=this.connections.length-1; i >= 0; i--)
            {
                if(this.connections[i].meta.id === connection.meta.id)
                {
                    this.connections.splice(i, 1);
                    break;
                }
            }

            this.connect();
        }
    }

    respond()
    {
        const client = this.waitingClients.shift();

        if(client)
        {
            for(const connection of this.connections)
            {
                if(connection.meta.available && connection.loggedIn)
                {
                    connection.meta.available = false;
                    connection.meta.timestamp = new Date();
                    clearTimeout(connection.meta.timerID);
                    connection.meta.timerID = setTimeout(() => this.removeConnection(connection, true), this.config.pool.idleTimeout);
                    logger.log('debug', `Reusing existing connection: ${connection.meta.id} (pool size: ${this.connections.length})`);
                    return client.callback(null, connection);
                }
            }

            this.waitingClients.unshift(client);
            this.openConnection();
        }
    }

    drain()
    {
        logger.log('debug', 'Draining connection pool (pool size: ${this.connections.length})');

        for(let i = this.connections.length-1; i >= 0; i--)
        {
            this.connections[i].close();
        }

        const error = new Error('Connection pool has been drained, no new connections can be opened');

        for(let i = this.waitingClients.length-1; i >= 0; i--)
        {
            this.waitingClients[i](error);
            this.waitingClients.splice(i, 1);
        }

        this.drained = true;
    }
}

module.exports = ConnectionPool;
