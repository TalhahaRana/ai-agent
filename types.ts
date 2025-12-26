export interface BookingDetails {
  customerName: string;
  serviceType: string;
  date: string;
  time: string;
  email: string;
}

export interface LogEntry {
  role: 'user' | 'model' | 'system';
  text: string;
  timestamp: Date;
}

export enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR',
}
