import { Link } from 'react-router-dom';
import { EmptyState } from '@/components/common';

export function NotFoundPage() {
  return (
    <EmptyState title="Page not found">
      <Link className="text-accent hover:underline" to="/">
        Back to the overview
      </Link>
    </EmptyState>
  );
}
