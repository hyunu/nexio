import { useState, useEffect } from 'react';
import BoardConsole from './BoardConsole';

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
  userId: string;
  status: string;
  connectedAt: string;
  updatedAt: string;
}

interface User {
  id: string;
  username: string;
  email: string;
  orgName: string;
  active: boolean;
  clientId: string;
  createdAt: string;
}

function App() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [selectedBoard, setSelectedBoard] = useState('');
  const [selectedClient, setSelectedClient] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [tab, setTab] = useState<'boards' | 'users'>('boards');
  const [consoleBoard, setConsoleBoard] = useState<string | null>(null);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  async function fetchData() {
    try {
      const [boardsRes, clientsRes, usersRes] = await Promise.all([
        fetch(`${API_BASE}/boards`),
        fetch(`${API_BASE}/clients`),
        fetch(`${API_BASE}/users`),
      ]);

      const boardsData = await boardsRes.json();
      const clientsData = await clientsRes.json();
      const usersData = await usersRes.json();

      setBoards(boardsData);
      setClients(clientsData);
      setUsers(usersData);
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
    <>
      {consoleBoard && <BoardConsole boardId={consoleBoard} onClose={() => setConsoleBoard(null)} />}
      {!consoleBoard && (
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: 20, fontFamily: 'system-ui' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h1 style={{ margin: 0 }}>Nexio Dashboard</h1>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              style={tabStyle(tab === 'boards')}
              onClick={() => setTab('boards')}
            >
              Boards
            </button>
            <button
              style={tabStyle(tab === 'users')}
              onClick={() => setTab('users')}
            >
              Users
            </button>
          </div>
        </div>

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

        {tab === 'boards' && (
          <>
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
                          <span style={{ ...badgeStyle, background: getStatusColor(board.status) }}>
                            {board.status}
                          </span>
                        </td>
                        <td style={tdStyle}>{new Date(board.connectedAt).toLocaleString()}</td>
                        <td style={tdStyle}>
                          <button style={buttonStyle} onClick={() => sendControl(board.uniqueId, 'RESET', 'board')}>
                            Reset
                          </button>
                          <button
                            style={{ ...buttonStyle, background: '#6b7280', marginLeft: 4 }}
                            onClick={async () => {
                              await fetch(`${API_BASE}/boards/${board.uniqueId}/discard`, { method: 'POST' });
                              fetchData();
                            }}
                          >
                            Discard
                          </button>
                          <button
                            style={{ ...buttonStyle, background: '#3b82f6', marginLeft: 4 }}
                            onClick={() => setConsoleBoard(board.uniqueId)}
                          >
                            Console
                          </button>
                        </td>
                      </tr>
                    ))}
                    {boards.length === 0 && (
                      <tr><td colSpan={4} style={{ ...tdStyle, textAlign: 'center' }}>No boards connected</td></tr>
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
                      <th style={thStyle}>User</th>
                      <th style={thStyle}>Status</th>
                      <th style={thStyle}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clients.map(client => (
                      <tr key={client.id}>
                        <td style={tdStyle}>{client.clientId}</td>
                        <td style={tdStyle}>{client.userId ? client.userId.substring(0, 8) : '-'}</td>
                        <td style={tdStyle}>
                          <span style={{ ...badgeStyle, background: getStatusColor(client.status) }}>
                            {client.status}
                          </span>
                        </td>
                        <td style={tdStyle}>
                          <button style={buttonStyle} onClick={() => sendControl(client.clientId, 'DISCONNECT', 'client')}>
                            Disconnect
                          </button>
                        </td>
                      </tr>
                    ))}
                    {clients.length === 0 && (
                      <tr><td colSpan={4} style={{ ...tdStyle, textAlign: 'center' }}>No clients connected</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={cardStyle}>
              <h2 style={sectionTitleStyle}>Create Session</h2>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <select style={selectStyle} value={selectedBoard} onChange={(e) => setSelectedBoard(e.target.value)}>
                  <option value="">Select Board</option>
                  {boards.filter(b => b.status === 'IDLE').map(board => (
                    <option key={board.id} value={board.uniqueId}>{board.uniqueId}</option>
                  ))}
                </select>
                <select style={selectStyle} value={selectedClient} onChange={(e) => setSelectedClient(e.target.value)}>
                  <option value="">Select Client</option>
                  {clients.map(client => (
                    <option key={client.id} value={client.clientId}>{client.clientId}</option>
                  ))}
                </select>
                <button style={{ ...buttonStyle, background: '#3b82f6' }} onClick={createSession} disabled={loading || !selectedBoard || !selectedClient}>
                  {loading ? 'Creating...' : 'Connect'}
                </button>
              </div>
            </div>
          </>
        )}

        {tab === 'users' && (
          <div style={cardStyle}>
            <h2 style={sectionTitleStyle}>Users ({users.length})</h2>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Username</th>
                  <th style={thStyle}>Email</th>
                  <th style={thStyle}>Organization</th>
                  <th style={thStyle}>Active</th>
                  <th style={thStyle}>Client</th>
                  <th style={thStyle}>Created</th>
                </tr>
              </thead>
              <tbody>
                {users.map(user => (
                  <tr key={user.id}>
                    <td style={tdStyle}><strong>{user.username}</strong></td>
                    <td style={tdStyle}>{user.email || '-'}</td>
                    <td style={tdStyle}>{user.orgName || '-'}</td>
                    <td style={tdStyle}>
                      <button
                        style={{
                          ...toggleStyle,
                          background: user.active ? '#22c55e' : '#ef4444',
                        }}
                        onClick={async () => {
                          await fetch(`${API_BASE}/users/${user.id}/toggle`, { method: 'POST' });
                          fetchData();
                        }}
                      >
                        {user.active ? 'Active' : 'Deactivated'}
                      </button>
                    </td>
                    <td style={tdStyle}>{user.clientId ? user.clientId.substring(0, 16) + '...' : '-'}</td>
                    <td style={tdStyle}>{new Date(user.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr><td colSpan={6} style={{ ...tdStyle, textAlign: 'center' }}>No users registered</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}
    </>
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

const tabStyle = (active: boolean): React.CSSProperties => ({
  padding: '8px 20px',
  border: 'none',
  borderRadius: 6,
  background: active ? '#3b82f6' : '#e5e7eb',
  color: active ? '#fff' : '#374151',
  fontSize: 14,
  fontWeight: 500,
  cursor: 'pointer',
});

const toggleStyle: React.CSSProperties = {
  padding: '4px 12px',
  border: 'none',
  borderRadius: 12,
  color: '#fff',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  minWidth: 90,
};

export default App;
