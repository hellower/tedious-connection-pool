const tedious = require('tedious');
let logger = {};

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

        if(typeof this.config.pool.log.log === 'function')
        {
            logger = this.config.pool.log;
        }
        
        else if(typeof this.config.pool.log === 'function')
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
                    clearTimeout(client.timerID);
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

                for(let i = this.waitingClients.length-1; i >= 0; i--)
                {
                    if(this.waitingClients[i].id === client.id)
                    {
                        this.waitingClients.splice(i, 1);
                        break;
                    }
                }

                client.callback(error);
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
        if(this.connections.length < this.config.pool.min)
        {
            logger.log('debug', `Refilling connection pool (pool size: ${this.connections.length})`);
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

    addConnection(error, connection)
    {
        if(error)
        {
            this.handleError(error, connection);
            return;
        }
        
        logger.log('debug', `Opened connection: ${connection.meta.id} (pool size: ${this.connections.length})`);

        if(this.connections.length+1 <= this.config.pool.max)
        {
            this.connections.push(connection);
            this.respond();
        }
        
        else
        {
            logger.log('debug', `Connection pool is full.`);
            connection.close();
        }
    }

    prepareConnection(connection)
    {
        connection.meta = {};
        connection.meta.id = ++this.connectionID;
        connection.meta.timestamp = new Date();
        connection.meta.available = true;
        connection.meta.timerID = setTimeout(() => this.removeConnection(connection), this.config.pool.idleTimeout);

        connection.once('connect', (error) => this.addConnection(error, connection));
        connection.once('error', (error) => this.handleError(error, connection));
        connection.on('infoMessage', (info) => logger.log('debug', `Error: ${info.number}. State: ${info.state}. Class: ${info.class}. Message: ${info.message}. Procedure: ${info.procedure}. Line Number: ${info.lineNumber}`));
        connection.on('errorMessage', (error) => logger.log('debug', `Error: ${error.number}. State: ${error.state}. Class: ${error.class}. Message: ${error.message}. Procedure: ${error.procedure}. Line Number: ${error.lineNumber}`));
        connection.once('end', () => this.removeConnection(connection, true));
        connection.release = () =>
        {
            connection.meta.timestamp = new Date();
            connection.meta.available = true;
            clearTimeout(connection.meta.timerID);
            connection.meta.timerID = setTimeout(() => this.removeConnection(connection), this.config.pool.idleTimeout);
            this.respond();
        };
    }

    openConnection()
    {
        const timestamps = this.connections.sort((a, b) =>
        {
            if(a.meta.timestamp < b.meta.timestamp)
            {
                return -1;
            }

            else if(a.meta.timestamp > b.meta.timestamp)
            {
                return 1;
            }

            return 0;
        });

        if(this.connections.length+1 <= this.config.pool.max && (this.connections.length <= 1 || timestamps[timestamps.length-1] - timestamps[0] >= this.config.pool.idleTimeout))
        {
            const connection = new tedious.Connection(this.config.connection);
            
            // kss
            /* 아래 이유로 이코드 추가함
            tedious deprecated in the next major version of `tedious`, creating a new `connection` instance will no longer establish a connection to the server automatically. 
            please use the new `connect` helper function or call the `.connect` method on the newly created `connection` object to silence this message
            */            
            connection.connect(function(err) {
                if (err) {
                    logger.log('debug',err);
                    return -2;
                } 
                
                logger.log('debug','connected !!');                    
                this.prepareConnection(connection);                
            })           
        }
    }

    removeConnection(connection, force)
    {
        if(force || (new Date() - connection.meta.timestamp >= this.config.pool.idleTimeout && this.connections.length-1 >= this.config.pool.min))
        {
            ['connect', 'error', 'errorMessage', 'infoMessage', 'end'].forEach((eventName) => connection.removeAllListeners(eventName));
            connection.close();
            
            for(let i=this.connections.length-1; i >= 0; i--)
            {
                if(this.connections[i].meta.id === connection.meta.id)
                {
                    this.connections.splice(i, 1);
                    break;
                }
            }

            logger.log('debug', `Closed connection: ${connection.meta.id} (pool size: ${this.connections.length})`);
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
                    connection.meta.timerID = setTimeout(() => this.removeConnection(connection), this.config.pool.idleTimeout);
                    logger.log('debug', `Reusing connection: ${connection.meta.id} (pool size: ${this.connections.length})`);
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
