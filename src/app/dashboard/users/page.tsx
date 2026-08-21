'use client';

import { useState } from 'react';
import { Users, Shield, Mail, CheckCircle2, Search } from 'lucide-react';
import styles from './users.module.css';

interface UserRecord {
  id: string;
  name: string;
  email: string;
  role: string;
  district: string;
  status: string;
}

const INITIAL_USERS: UserRecord[] = [
  { id: '1', name: 'Rajesh Sharma', email: 'rajesh.lmo@vtula.gov.in', role: 'LMO', district: 'Ahmedabad', status: 'Active' },
  { id: '2', name: 'Gujarat Calibration Center', email: 'lab@gatc-gujarat.org', role: 'GATC', district: 'Surat', status: 'Active' },
  { id: '3', name: 'Kishan Trading Corporation', email: 'owner@kishantrading.in', role: 'Owner', district: 'Rajkot', status: 'Active' },
];

export default function UsersManagementPage() {
  const [users] = useState<UserRecord[]>(INITIAL_USERS);
  const [search, setSearch] = useState('');

  const filtered = users.filter(
    (u) =>
      u.name.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase()) ||
      u.role.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1>User Management</h1>
          <p>State Legal Metrology officers, GATC test centers, and registered merchant accounts.</p>
        </div>
      </div>

      <div className={styles.searchBar}>
        <Search size={18} />
        <input
          type="text"
          placeholder="Search by name, email, or role..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="clay-table-wrapper">
        <table className="clay-table">
          <thead>
            <tr>
              <th>User Name</th>
              <th>Email Address</th>
              <th>Role</th>
              <th>District Jurisdiction</th>
              <th>Account Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => (
              <tr key={u.id}>
                <td><strong>{u.name}</strong></td>
                <td>{u.email}</td>
                <td>
                  <span className="clay-badge clay-badge-primary">{u.role}</span>
                </td>
                <td>{u.district}</td>
                <td>
                  <span className="clay-badge clay-badge-success">{u.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
