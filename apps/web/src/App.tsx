import { useState, useEffect } from 'react';

const API_BASE = 'http://localhost:10008/api';

interface Board {
  id: string;
  uniqueId: string;
  macAddress: string;
  status: string;
  connectedAt: string;
  updatedAt: string;
}

interface Client {
  id: string;
  clientId: string;
  status: string;
  connectedAt: string;
  updatedAt: string;
}

interface Session {
  id: string;
  boardId: string;
  clientId: string;
  assignedAt: string;
  expiresAt: string;
  status: string;
}

function App() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedBoard, setSelectedBoard] = useState('');
  const [selectedClient, setSelectedClient] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  async function fetchData() {
    try {
      const [boardsRes, clientsRes] = await Promise.all([
        fetch(`${API_BASE}/boards`),
        fetch(`${API_BASE}/clients`),
      ]);

      const boardsData = await boardsRes.json();
      const clientsData = await clientsRes.json();

      setBoards(boardsData);
      setClients(clientsData);
    } catch (err) {
      console.error('Fetch error:', err);
    }
  }

  async function createSession() {
    if (!selectedBoard || !selectedClient) {
      setMessage('Please select both board and client');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boardId: selectedBoard,
          clientId: selectedClient,
          duration: 3600,
        }),
      });

      if (res.ok) {
        setMessage('Session created successfully');
        fetchData();
      } else {
        const err = await res.json();
        setMessage(`Error: ${err.error}`);
      }
    } catch (err) {
      setMessage('Failed to create session');
    }
    setLoading(false);
  }

  async function sendControl(targetId: string, action: string, type: string) {
    try {
      await fetch(`${API_BASE}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId, action, type }),
      });
      setMessage(`Control ${action} sent`);
    } catch (err) {
      setMessage('Failed to send control');
    }
  }

  function getStatusColor(status: string): string {
    switch (status) {
      case 'IDLE':
        return '#22c55e';
      case 'BUSY':
        return '#f59e0b';
      case 'OFFLINE':
        return '#ef4444';
      case 'CONNECTED':
        return '#22c55e';
      case 'DISCONNECTED':
        return '#ef4444';
      default:
        return '#888';
    }
  }

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: 20, fontFamily: 'system-ui' }}>
      <h1 style={{ marginBottom: 20 }}>Nexio Dashboard</h1>

      {message && (
        <div style={{
          padding: 12,
          background: message.includes('Error') ? '#fee2e2' : '#dcfce7',
          color: message.includes('Error') ? '#991b1b' : '#166534',
          borderRadius: 4,
          marginBottom: 20,
        }}>
          {message}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div style={cardStyle}>
          <h2 style={sectionTitleStyle}>Boards ({boards.length})</h2>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Unique ID</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Connected</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {boards.map(board => (
                <tr key={board.id}>
                  <td style={tdStyle}>{board.uniqueId}</td>
                  <td style={tdStyle}>
                    <span style={{
                      ...badgeStyle,
                      background: getStatusColor(board.status),
                    }}>
                      {board.status}
                    </span>
                  </td>
                  <td style={tdStyle}>{new Date(board.connectedAt).toLocaleString()}</td>
                  <td style={tdStyle}>
                    <button
                      style={buttonStyle}
                      onClick={() => sendControl(board.uniqueId, 'RESET', 'board')}
                    >
                      Reset
                    </button>
                  </td>
                </tr>
              ))}
              {boards.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ ...tdStyle, textAlign: 'center' }}>
                    No boards connected
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div style={cardStyle}>
          <h2 style={sectionTitleStyle}>Clients ({clients.length})</h2>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Client ID</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Connected</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {clients.map(client => (
                <tr key={client.id}>
                  <td style={tdStyle}>{client.clientId}</td>
                  <td style={tdStyle}>
                    <span style={{
                      ...badgeStyle,
                      background: getStatusColor(client.status),
                    }}>
                      {client.status}
                    </span>
                  </td>
                  <td style={tdStyle}>{new Date(client.connectedAt).toLocaleString()}</td>
                  <td style={tdStyle}>
                    <button
                      style={buttonStyle}
                      onClick={() => sendControl(client.clientId, 'DISCONNECT', 'client')}
                    >
                      Disconnect
                    </button>
                  </td>
                </tr>
              ))}
              {clients.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ ...tdStyle, textAlign: 'center' }}>
                    No clients connected
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div style={cardStyle}>
        <h2 style={sectionTitleStyle}>Create Session</h2>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select
            style={selectStyle}
            value={selectedBoard}
            onChange={(e) => setSelectedBoard(e.target.value)}
          >
            <option value="">Select Board</option>
            {boards.filter(b => b.status === 'IDLE').map(board => (
              <option key={board.id} value={board.uniqueId}>
                {board.uniqueId}
              </option>
            ))}
          </select>
          <select
            style={selectStyle}
            value={selectedClient}
            onChange={(e) => setSelectedClient(e.target.value)}
          >
            <option value="">Select Client</option>
            {clients.map(client => (
              <option key={client.id} value={client.clientId}>
                {client.clientId}
              </option>
            ))}
          </select>
          <button
            style={{ ...buttonStyle, background: '#3b82f6' }}
            onClick={createSession}
            disabled={loading || !selectedBoard || !selectedClient}
          >
            {loading ? 'Creating...' : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: '#fff',
  borderRadius: 8,
  padding: 20,
  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
};

const sectionTitleStyle: React.CSSProperties = {
  marginBottom: 16,
  fontSize: 18,
  color: '#333',
};

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
};

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 12px',
  borderBottom: '2px solid #eee',
  fontWeight: 600,
  fontSize: 14,
};

const tdStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid #eee',
  fontSize: 14,
};

const badgeStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 4,
  fontSize: 12,
  fontWeight: 500,
  color: '#fff',
};

const buttonStyle: React.CSSProperties = {
  padding: '4px 12px',
  border: 'none',
  borderRadius: 4,
  background: '#ef4444',
  color: '#fff',
  fontSize: 12,
  cursor: 'pointer',
};

const selectStyle: React.CSSProperties = {
  padding: '8px 12px',
  border: '1px solid #ddd',
  borderRadius: 4,
  fontSize: 14,
  minWidth: 150,
};

export default App;
