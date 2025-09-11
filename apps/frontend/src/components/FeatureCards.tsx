interface Feature {
  icon: string;
  title: string;
  description: string;
  status: 'planned' | 'active' | 'beta';
}

const features: Feature[] = [
  {
    icon: '📊',
    title: 'Semantic Content',
    description: 'Entity recognition, knowledge graphs, and semantic relationships',
    status: 'planned',
  },
  {
    icon: '🤝',
    title: 'Real-time Collaboration',
    description: 'Live editing, AI-assisted workflows, conflict resolution, and team coordination',
    status: 'planned',
  },
  {
    icon: '🔐',
    title: 'Advanced RBAC',
    description: 'Fine-grained permissions, asset-level control, and audit trails',
    status: 'planned',
  },
];

function FeatureCard({ feature }: { feature: Feature }) {
  const statusColors = {
    planned: 'text-amber-600 dark:text-amber-400',
    active: 'text-green-600 dark:text-green-400',
    beta: 'text-blue-600 dark:text-blue-400',
  };

  return (
    <article 
      className="p-6 bg-white dark:bg-gray-900 rounded-lg shadow-md hover:shadow-lg transition-shadow focus-within:ring-2 focus-within:ring-blue-500 focus-within:ring-offset-2"
      role="article"
      aria-labelledby={`feature-${feature.title.toLowerCase().replace(/\s+/g, '-')}-title`}
    >
      <h3 
        id={`feature-${feature.title.toLowerCase().replace(/\s+/g, '-')}-title`}
        className="font-bold mb-2 flex items-center font-sans"
      >
        <span className="mr-2 text-lg" role="img" aria-label={`${feature.title} icon`}>
          {feature.icon}
        </span>
        {feature.title}
      </h3>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
        {feature.description}
      </p>
      <span 
        className={`text-xs font-medium ${statusColors[feature.status]} inline-flex items-center px-2 py-1 rounded-full bg-opacity-10`}
        aria-label={`Feature status: ${feature.status}`}
      >
        <span className="w-2 h-2 rounded-full mr-1" 
              style={{
                backgroundColor: feature.status === 'planned' ? '#d97706' : 
                                feature.status === 'active' ? '#059669' : '#2563eb'
              }}
              aria-hidden="true"
        />
        {feature.status.charAt(0).toUpperCase() + feature.status.slice(1)}
      </span>
    </article>
  );
}

export function FeatureCards() {
  return (
    <section className="mt-8 font-sans" aria-labelledby="features-heading">
      <h2 id="features-heading" className="sr-only">Upcoming Features</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4" role="list">
        {features.map((feature, index) => (
          <FeatureCard 
            key={`${feature.title}-${index}`} 
            feature={feature} 
          />
        ))}
      </div>
    </section>
  );
}